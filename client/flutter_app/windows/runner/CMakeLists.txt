cmake_minimum_required(VERSION 3.14)
project(runner LANGUAGES CXX)

set(WEBVIEW_VERSION "1.0.1210.39")
set(NUGET_URL https://dist.nuget.org/win-x86-commandline/v5.10.0/nuget.exe)
set(NUGET_SHA256 852b71cc8c8c2d40d09ea49d321ff56fd2397b9d6ea9f96e532530307bbbafd3)

find_program(NUGET nuget)
if(NOT NUGET)
  set(NUGET ${CMAKE_BINARY_DIR}/nuget.exe)
  if(NOT EXISTS ${NUGET})
    file(DOWNLOAD ${NUGET_URL} ${NUGET})
  endif()
  file(SHA256 ${NUGET} NUGET_DL_HASH)
  if(NOT NUGET_DL_HASH STREQUAL NUGET_SHA256)
    message(FATAL_ERROR "Integrity check for ${NUGET} failed.")
  endif()
endif()

set(WEBVIEW2_PACKAGE_DIR "${CMAKE_BINARY_DIR}/packages/Microsoft.Web.WebView2")

add_custom_target(sphere_overlay_webview2_deps)
add_custom_command(
  TARGET sphere_overlay_webview2_deps PRE_BUILD
  COMMAND ${NUGET} install Microsoft.Web.WebView2 -Version ${WEBVIEW_VERSION} -ExcludeVersion -OutputDirectory ${CMAKE_BINARY_DIR}/packages
)

# Define the application target. To change its name, change BINARY_NAME in the
# top-level CMakeLists.txt, not the value here, or `flutter run` will no longer
# work.
#
# Any new source files that you add to the application should be added here.
add_executable(${BINARY_NAME} WIN32
  "flutter_window.cpp"
  "main.cpp"
  "sphere_overlay_window.cpp"
  "utils.cpp"
  "win32_window.cpp"
  "${FLUTTER_MANAGED_DIR}/generated_plugin_registrant.cc"
  "Runner.rc"
  "runner.exe.manifest"
)

# Apply the standard set of build settings. This can be removed for applications
# that need different build settings.
apply_standard_settings(${BINARY_NAME})

# Add preprocessor definitions for the build version.
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION=\"${FLUTTER_VERSION}\"")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MAJOR=${FLUTTER_VERSION_MAJOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MINOR=${FLUTTER_VERSION_MINOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_PATCH=${FLUTTER_VERSION_PATCH}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_BUILD=${FLUTTER_VERSION_BUILD}")

# Disable Windows macros that collide with C++ standard library functions.
target_compile_definitions(${BINARY_NAME} PRIVATE "NOMINMAX")

# Add dependency libraries and include directories. Add any application-specific
# dependencies here.
target_link_libraries(${BINARY_NAME} PRIVATE flutter flutter_wrapper_app)
target_link_libraries(${BINARY_NAME} PRIVATE "dwmapi.lib")
target_include_directories(${BINARY_NAME} PRIVATE
  "${CMAKE_SOURCE_DIR}"
  "${WEBVIEW2_PACKAGE_DIR}/build/native/include"
)
target_link_libraries(${BINARY_NAME} PRIVATE
  "${WEBVIEW2_PACKAGE_DIR}/build/native/x64/WebView2LoaderStatic.lib"
)
add_dependencies(${BINARY_NAME} sphere_overlay_webview2_deps)

# Run the Flutter tool portions of the build. This must not be removed.
add_dependencies(${BINARY_NAME} flutter_assemble)
