// Included inside main.cpp's private namespace. This command only publishes a
// flushed editor save; it is not an AI file operation or an additional IPC API.
std::wstring document_absolute_path(std::string_view raw) {
  if (raw.empty() || raw.size() > 131040 || raw.find('\0') != std::string_view::npos) throw std::runtime_error("path");
  std::wstring value = utf16(raw);
  const bool drive = value.size() > 3 && iswalpha(value[0]) && value[1] == L':' && value[2] == L'\\';
  const bool unc = value.rfind(L"\\\\", 0) == 0 && value.rfind(L"\\\\?\\", 0) != 0 && value.rfind(L"\\\\.\\", 0) != 0;
  if ((!drive && !unc) || value.size() > 32700 || value.find(L'/') != std::wstring::npos) throw std::runtime_error("path");
  std::string components = utf8(value.substr(drive ? 3 : 2));
  std::replace(components.begin(), components.end(), '\\', '/');
  const auto validated = validate_relative(components, false);
  if (unc && validated.size() < 3) throw std::runtime_error("path");
  return value;
}

std::wstring document_parent(const std::wstring& value) {
  const std::size_t slash = value.find_last_of(L'\\');
  return value.substr(0, slash == 2 && value[1] == L':' ? 3 : slash);
}

unique_handle open_document_path(const std::wstring& absolute, DWORD access, DWORD share, bool directory) {
  // Cloud placeholders and compressed files may carry non-name-surrogate reparse
  // tags. They are ordinary documents; let their filesystem provider hydrate them.
  // Canonical final-path checks still reject a redirected path/junction/symlink.
  unique_handle file(CreateFileW(extended(absolute).c_str(), access, share, nullptr, OPEN_EXISTING,
      directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL, nullptr));
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!file || GetFileType(file.get()) != FILE_TYPE_DISK
      || !GetFileInformationByHandleEx(file.get(), FileAttributeTagInfo, &info, sizeof(info))
      || ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && IsReparseTagNameSurrogate(info.ReparseTag))
      || ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory
      || !equals_path(final_path(file.get()), absolute)) throw std::runtime_error("document path");
  return file;
}

bool restore_document(HANDLE original, const std::wstring& destination) {
  const auto absolute = extended(destination);
  const auto name_bytes = absolute.size() * sizeof(wchar_t);
  const auto size = offsetof(FILE_RENAME_INFO, FileName) + name_bytes + sizeof(wchar_t);
  std::vector<unsigned char> bytes(size, 0);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = nullptr;
  rename->FileNameLength = static_cast<DWORD>(name_bytes);
  std::memcpy(rename->FileName, absolute.data(), name_bytes);
  return SetFileInformationByHandle(original, FileRenameInfo, rename, static_cast<DWORD>(size)) != FALSE;
}

bool document_matches(const std::wstring& path, Identity expected, const std::string& revision) {
  try {
    auto file = open_document_path(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false);
    return same_identity(identity(file.get()), expected)
        && sha256_handle(file.get(), nullptr, (std::numeric_limits<std::size_t>::max)()) == revision;
  } catch (...) { return false; }
}

int replace_document(const Json& envelope, const std::string& request_id) {
  const auto reply = [&](std::string_view status, std::string_view reason) {
    return write_response(request_id, std::string(status), std::string(reason)) ? 0 : 3;
  };
  if (!exact_keys(envelope, {"protocolVersion", "requestId", "command", "request"})
      || unsigned_number(field(envelope, "protocolVersion")) != kProtocolVersion) throw std::runtime_error("schema");
  const auto& body = field(envelope, "request");
  if (!exact_keys(body, {"destinationPath", "temporaryPath", "destinationIdentity", "temporaryIdentity", "expectedRevision", "replacementRevision"})) throw std::runtime_error("schema");
  const auto destination = document_absolute_path(string_value(field(body, "destinationPath")));
  const auto temporary = document_absolute_path(string_value(field(body, "temporaryPath")));
  const auto parent_path = document_parent(destination);
  const auto destination_name = destination.substr(destination.find_last_of(L'\\') + 1);
  const auto temporary_name = temporary.substr(temporary.find_last_of(L'\\') + 1);
  const auto original_id = compatibility_identity(string_value(field(body, "destinationIdentity")));
  const auto replacement_id = compatibility_identity(string_value(field(body, "temporaryIdentity")));
  const auto original_revision = string_value(field(body, "expectedRevision"));
  const auto replacement_revision = string_value(field(body, "replacementRevision"));
  if (!equals_path(parent_path, document_parent(temporary)) || same_identity(original_id, replacement_id)
      || temporary_name.rfind(L"." + destination_name + L".", 0) != 0 || !temporary_name.ends_with(L".tmp")
      || !valid_hex(original_revision, 64) || !valid_hex(replacement_revision, 64)) throw std::runtime_error("schema");

  unique_handle parent;
  unique_handle original;
  unique_handle replacement;
  try {
    parent = open_document_path(parent_path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, true);
    original = open_document_path(destination, GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false);
    replacement = open_document_path(temporary, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false);
    if (!same_identity(identity(original.get()), original_id) || !same_identity(identity(replacement.get()), replacement_id)
        || !document_matches(destination, original_id, original_revision)
        || !document_matches(temporary, replacement_id, replacement_revision)) return reply("rejected", "source-changed");
  } catch (...) { return reply("rejected", "unsupported"); }

  // Reserve a unique sibling name. ReplaceFileW can fail after renaming the old
  // destination; an explicit backup ensures those failures retain the old bytes.
  const auto backup_name = random_hex_name(L".arkdown-save-") + L".bak";
  const auto backup = join_relative(parent_path, {backup_name});
  unique_handle reservation;
  try {
    reservation.reset(CreateFileW(extended(backup).c_str(), GENERIC_READ | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_HIDDEN, nullptr));
    if (!reservation || !equals_path(final_path(reservation.get()), backup)) throw std::runtime_error("backup");
  } catch (...) { return reply("rejected", "unsupported"); }
  const auto reservation_id = identity(reservation.get());
  reservation.reset();
  const auto remove_reservation = [&]() {
    // Only this exact empty placeholder may be discarded on a rejected save.
    try {
      auto placeholder = open_document_path(backup, GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false);
      if (same_identity(identity(placeholder.get()), reservation_id)) dispose_handle(placeholder.get());
    } catch (...) { /* retain anything whose ownership cannot be established */ }
  };

  try {
    wait_at_named_test_barrier(L"ARKDOWN_DOCUMENT_REPLACE_TEST_BARRIER");
    if (!equals_path(final_path(parent.get()), parent_path)
        || !document_matches(destination, original_id, original_revision)
        || !document_matches(temporary, replacement_id, replacement_revision)) {
      remove_reservation();
      return reply("rejected", "source-changed");
    }
  } catch (...) { remove_reservation(); return reply("rejected", "unsupported"); }

  // ReplaceFileW opens the replacement with no sharing; release our read handle
  // after the final verification, while retaining the original and parent pins.
  replacement = unique_handle();
  BOOL replaced = FALSE;
#ifdef ARKDOWN_HELPER_TEST_HOOKS
  wchar_t fault[32]{};
  GetEnvironmentVariableW(L"ARKDOWN_DOCUMENT_REPLACE_TEST_FAULT", fault, 32);
  if (std::wstring_view(fault) == L"after-backup") {
    // Reproduce ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: original is now the backup,
    // destination is absent, and the new bytes have not been published.
    remove_reservation();
    if (!MoveFileExW(extended(destination).c_str(), extended(backup).c_str(), 0)) return reply("unknown", "commit_verification_failed");
  } else
#endif
  {
    // No IGNORE_ACL/MERGE_ERRORS, and no unsupported WRITE_THROUGH flag. The
    // renderer service has already fsynced the temporary file before this call.
    replaced = ReplaceFileW(extended(destination).c_str(), extended(temporary).c_str(), extended(backup).c_str(), 0, nullptr, nullptr);
  }
#ifdef ARKDOWN_HELPER_TEST_HOOKS
  if (std::wstring_view(fault) == L"after-replace") replaced = FALSE;
#endif
  // From here onwards exceptions/results are uncertain, never a pre-write rejection.
  try {
    if (replaced) {
      if (!document_matches(destination, replacement_id, replacement_revision)
          || !document_matches(backup, original_id, original_revision)) return reply("unknown", "post_commit_verification_failed");
      // Delete by the held OLD identity, never by an unverified backup pathname.
      if (!equals_path(final_path(original.get()), backup) || !dispose_handle(original.get())) return reply("unknown", "cleanup_ambiguous");
      return reply("committed", "");
    }
    if (document_matches(destination, original_id, original_revision)) {
      remove_reservation();
      return reply("rejected", "unsupported");
    }
    // Restore only into an absent destination. An intervening user's file must
    // never be overwritten. If recovery is uncertain, leave the backup in place.
    if (document_matches(backup, original_id, original_revision)
        && equals_path(final_path(original.get()), backup)
        && equals_path(final_path(parent.get()), parent_path)
        && restore_document(original.get(), destination)
        && document_matches(destination, original_id, original_revision)) return reply("rejected", "unsupported");
  } catch (...) { /* retain the old-file backup for recovery */ }
  return reply("unknown", "post_commit_verification_failed");
}
