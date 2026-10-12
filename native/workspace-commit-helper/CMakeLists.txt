cmake_minimum_required(VERSION 3.24)
project(arkdown_workspace_commit LANGUAGES CXX RC)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Arkdown workspace commit helper requires MSVC on Windows")
endif()
if(NOT DEFINED ARKDOWN_HELPER_OUTPUT_DIR)
  message(FATAL_ERROR "ARKDOWN_HELPER_OUTPUT_DIR is required")
endif()
option(ARKDOWN_HELPER_TEST_HOOKS "Enable deterministic integration-test barriers" OFF)

# This component ships in lockstep with Arkdown. Reconfigure on every build so
# package.json is the version source, including incremental release builds.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../../package.json" ARKDOWN_PACKAGE_JSON)
string(JSON ARKDOWN_PRODUCT_VERSION GET "${ARKDOWN_PACKAGE_JSON}" version)
if(NOT ARKDOWN_PRODUCT_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR "Workspace helper requires a three-part Arkdown release version")
endif()
string(REPLACE "." ";" ARKDOWN_VERSION_PARTS "${ARKDOWN_PRODUCT_VERSION}")
foreach(PART IN LISTS ARKDOWN_VERSION_PARTS)
  if(PART GREATER 65535)
    message(FATAL_ERROR "Windows version fields must be within 0..65535")
  endif()
endforeach()
set(ARKDOWN_HELPER_VERSION "${ARKDOWN_PRODUCT_VERSION}.0")
string(REPLACE "." "," ARKDOWN_VERSION_NUMERIC "${ARKDOWN_HELPER_VERSION}")
configure_file(src/version.rc.in "${CMAKE_CURRENT_BINARY_DIR}/version.rc" @ONLY)
add_executable(arkdown-workspace-commit src/main.cpp "${CMAKE_CURRENT_BINARY_DIR}/version.rc")
target_compile_features(arkdown-workspace-commit PRIVATE cxx_std_20)
target_compile_definitions(arkdown-workspace-commit PRIVATE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
if(ARKDOWN_HELPER_TEST_HOOKS)
  target_compile_definitions(arkdown-workspace-commit PRIVATE ARKDOWN_HELPER_TEST_HOOKS=1)
endif()
target_compile_options(arkdown-workspace-commit PRIVATE
  /utf-8 /W4 /WX /permissive- /EHsc /GS /guard:cf /sdl)
target_link_options(arkdown-workspace-commit PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
target_link_libraries(arkdown-workspace-commit PRIVATE bcrypt advapi32 ole32 shell32)
set_property(TARGET arkdown-workspace-commit PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
set_target_properties(arkdown-workspace-commit PROPERTIES
  OUTPUT_NAME "arkdown-workspace-commit"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ARKDOWN_HELPER_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY "${ARKDOWN_HELPER_OUTPUT_DIR}")
