from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import shutil
import stat as stat_module
import sys
import tempfile

from markitdown import MarkItDown
from markitdown.converters import EpubConverter, PdfConverter, PptxConverter, XlsxConverter


FORMATS = {'.pdf', '.pptx', '.xlsx', '.epub'}
WINDOWS_DRIVE_REMOTE = 4
WINDOWS_REPARSE_POINT = getattr(stat_module, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x10
WINDOWS_GENERIC_READ = 0x80000000
WINDOWS_FILE_SHARE_READ = 0x1
WINDOWS_OPEN_EXISTING = 3
WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
WINDOWS_FILE_TYPE_DISK = 0x1


def _reject_windows_colon_forms(value: str) -> None:
    if os.name != 'nt':
        return
    windows_form = value.replace('/', '\\')
    if (
        len(windows_form) < 3
        or not ('A' <= windows_form[0] <= 'Z' or 'a' <= windows_form[0] <= 'z')
        or windows_form[1] != ':'
        or windows_form[2] != '\\'
        or windows_form.count(':') != 1
    ):
        raise ValueError('invalid_input')


def _reject_network_or_device_path(value: str, path: Path) -> None:
    windows_form = value.replace('/', '\\')
    if windows_form.startswith('\\\\') or windows_form.startswith('\\??\\'):
        raise ValueError('non_local_path')
    if os.name != 'nt':
        return
    anchor = path.anchor
    if not anchor or anchor.startswith('\\\\'):
        raise ValueError('non_local_path')
    drive_type = ctypes.windll.kernel32.GetDriveTypeW(anchor)  # type: ignore[attr-defined]
    if drive_type == WINDOWS_DRIVE_REMOTE:
        raise ValueError('non_local_path')


def absolute_path(value: str) -> Path:
    _reject_windows_colon_forms(value)
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError('path must be absolute')
    _reject_network_or_device_path(value, path)
    return path


def _is_link_or_reparse(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, 'st_file_attributes', 0)
    return stat_module.S_ISLNK(metadata.st_mode) or bool(attributes & WINDOWS_REPARSE_POINT)


def _validated_input_path(value: str | Path) -> Path:
    supplied = os.fspath(value)
    path = absolute_path(supplied)
    if path.suffix.lower() not in FORMATS:
        raise ValueError('unsupported_format')
    if '..' in path.parts:
        raise ValueError('invalid_input')
    return path


def _validate_unlocked_path(path: Path, *, require_directory: bool) -> Path:
    current = Path(path.anchor)
    final_metadata: os.stat_result | None = None
    for part in path.parts[1:]:
        current /= part
        try:
            final_metadata = os.lstat(current)
        except OSError as error:
            raise ValueError('invalid_input') from error
        if _is_link_or_reparse(final_metadata):
            raise ValueError('invalid_input')
    if final_metadata is None:
        raise ValueError('invalid_input')
    if require_directory and not stat_module.S_ISDIR(final_metadata.st_mode):
        raise ValueError('invalid_input')
    if not require_directory and not stat_module.S_ISREG(final_metadata.st_mode):
        raise ValueError('invalid_input')

    resolved = path.resolve(strict=True)
    _reject_network_or_device_path(str(resolved), resolved)
    return resolved


def _validate_unlocked_regular_input(path: Path) -> Path:
    return _validate_unlocked_path(path, require_directory=False)


def _validate_unlocked_directory(path: Path) -> Path:
    return _validate_unlocked_path(path, require_directory=True)


def _normalized_windows_handle_path(value: str) -> str:
    if value.startswith('\\\\?\\UNC\\'):
        value = f'\\\\{value[8:]}'
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return os.path.normcase(os.path.normpath(value))


@contextmanager
def _open_verified_windows_source(path: Path, expected: Path):
    import msvcrt
    from ctypes import wintypes

    class FileAttributeTagInfo(ctypes.Structure):
        _fields_ = [
            ('file_attributes', wintypes.DWORD),
            ('reparse_tag', wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    get_file_information = kernel32.GetFileInformationByHandleEx
    get_file_information.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    get_file_information.restype = wintypes.BOOL
    get_file_type = kernel32.GetFileType
    get_file_type.argtypes = [wintypes.HANDLE]
    get_file_type.restype = wintypes.DWORD
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    get_final_path.restype = wintypes.DWORD
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    invalid_handle = ctypes.c_void_p(-1).value
    handle: int | None = None
    try:
        handle = create_file(
            str(path),
            WINDOWS_GENERIC_READ,
            WINDOWS_FILE_SHARE_READ,
            None,
            WINDOWS_OPEN_EXISTING,
            WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        if handle == invalid_handle:
            error_code = ctypes.get_last_error()
            raise OSError(error_code, ctypes.FormatError(error_code), str(path))
        information = FileAttributeTagInfo()
        if not get_file_information(handle, 9, ctypes.byref(information), ctypes.sizeof(information)):
            raise ctypes.WinError(ctypes.get_last_error())
        if (
            information.file_attributes & WINDOWS_REPARSE_POINT
            or information.file_attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY
            or get_file_type(handle) != WINDOWS_FILE_TYPE_DISK
        ):
            raise ValueError('invalid_input')
        required = get_final_path(handle, None, 0, 0)
        if required == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        final_path_buffer = ctypes.create_unicode_buffer(required + 1)
        written = get_final_path(handle, final_path_buffer, len(final_path_buffer), 0)
        if written == 0 or written >= len(final_path_buffer):
            raise ctypes.WinError(ctypes.get_last_error())
        actual = _normalized_windows_handle_path(final_path_buffer.value)
        revalidated = _validate_unlocked_regular_input(path)
        if (
            actual != _normalized_windows_handle_path(str(expected))
            or actual != _normalized_windows_handle_path(str(revalidated))
        ):
            raise ValueError('invalid_input')
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | getattr(os, 'O_BINARY', 0))
        handle = None
        with os.fdopen(descriptor, 'rb', closefd=True) as source_handle:
            yield source_handle
    finally:
        if handle is not None and handle != invalid_handle:
            close_handle(handle)


@contextmanager
def snapshotted_local_regular_input(value: str | Path, task_root: Path):
    path = _validated_input_path(value)
    resolved = _validate_unlocked_regular_input(path)
    if os.name != 'nt':
        yield resolved
        return

    with _open_verified_windows_source(path, resolved) as source_handle:
        with tempfile.TemporaryDirectory(
            prefix='arkdown-markitdown-input-',
            dir=task_root,
        ) as temporary_root_name:
            temporary_root = Path(temporary_root_name)
            _validate_unlocked_directory(temporary_root)
            snapshot = temporary_root / f'input{path.suffix.lower()}'
            with snapshot.open('xb') as snapshot_handle:
                shutil.copyfileobj(source_handle, snapshot_handle, length=1024 * 1024)
                snapshot_handle.flush()
                os.fsync(snapshot_handle.fileno())
            snapshot_metadata = os.lstat(snapshot)
            if _is_link_or_reparse(snapshot_metadata) or not stat_module.S_ISREG(snapshot_metadata.st_mode):
                raise ValueError('invalid_input')
            yield snapshot


def validate_local_regular_input(value: str | Path) -> Path:
    return _validate_unlocked_regular_input(_validated_input_path(value))


def write_atomic_text(destination: Path, text: str) -> None:
    if destination.exists():
        raise FileExistsError('destination already exists')
    if not destination.parent.is_dir():
        raise FileNotFoundError('destination directory does not exist')
    pending_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w',
            encoding='utf-8',
            newline='\n',
            dir=destination.parent,
            prefix=f'.{destination.name}.',
            suffix='.pending',
            delete=False,
        ) as pending:
            pending.write(text)
            pending.flush()
            os.fsync(pending.fileno())
            pending_name = pending.name
        os.replace(pending_name, destination)
        pending_name = None
    finally:
        if pending_name is not None:
            Path(pending_name).unlink(missing_ok=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(allow_abbrev=False)
    result.add_argument('--input', required=True, type=absolute_path)
    result.add_argument('--output', required=True, type=absolute_path)
    result.add_argument('--status', required=True, type=absolute_path)
    return result


def validated_task_outputs(output: Path, status: Path) -> tuple[Path, Path, Path]:
    if '..' in output.parts or '..' in status.parts:
        raise ValueError('invalid_output')
    if output.name != 'output.md' or status.name != 'status.json':
        raise ValueError('invalid_output')
    if output.parent != status.parent:
        raise ValueError('invalid_output')
    task_root = _validate_unlocked_directory(output.parent)
    current_root = _validate_unlocked_directory(Path.cwd())
    if task_root != current_root:
        raise ValueError('invalid_output')
    canonical_output = task_root / 'output.md'
    canonical_status = task_root / 'status.json'
    if output != canonical_output or status != canonical_status:
        raise ValueError('invalid_output')
    if os.path.lexists(output) or os.path.lexists(status):
        raise ValueError('invalid_output')
    return canonical_output, canonical_status, task_root


def convert(source: Path, output: Path, task_root: Path) -> int:
    with snapshotted_local_regular_input(source, task_root) as conversion_source:
        converter = MarkItDown(enable_builtins=False, enable_plugins=False)
        converter.register_converter(PdfConverter())
        converter.register_converter(PptxConverter())
        converter.register_converter(XlsxConverter())
        converter.register_converter(EpubConverter())
        result = converter.convert_local(str(conversion_source))
        text = result.markdown
        if not isinstance(text, str):
            raise TypeError('invalid_conversion_result')
    write_atomic_text(output, text)
    return len(text)


def main() -> int:
    args = parser().parse_args()
    source: Path = args.input
    try:
        output, status, task_root = validated_task_outputs(args.output, args.status)
    except Exception:
        return 2
    try:
        chars = convert(source, output, task_root)
        write_atomic_text(status, json.dumps({'ok': True, 'chars': chars}))
        return 0
    except Exception:
        if not status.exists() and status.parent.is_dir():
            try:
                write_atomic_text(status, json.dumps({'ok': False, 'error': 'conversion_failed'}))
            except Exception:
                pass
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
