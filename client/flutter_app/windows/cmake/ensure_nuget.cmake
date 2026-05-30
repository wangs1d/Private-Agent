# Bootstrap nuget.exe for WebView2 / WIL package restores (runner + webview_windows).
set(_PRIVATE_AI_NUGET_URL https://dist.nuget.org/win-x86-commandline/v5.10.0/nuget.exe)
set(_PRIVATE_AI_NUGET_SHA256 852b71cc8c8c2d40d09ea49d321ff56fd2397b9d6ea9f96e532530307bbbafd3)
get_filename_component(_PRIVATE_AI_WINDOWS_DIR "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(_PRIVATE_AI_NUGET_TOOLS_DIR "${_PRIVATE_AI_WINDOWS_DIR}/tools")

list(APPEND CMAKE_PROGRAM_PATH "${_PRIVATE_AI_NUGET_TOOLS_DIR}")

find_program(PRIVATE_AI_NUGET_EXE
  NAMES nuget nuget.exe
  PATHS "${_PRIVATE_AI_NUGET_TOOLS_DIR}" "${CMAKE_BINARY_DIR}"
  NO_DEFAULT_PATH
)
if(NOT PRIVATE_AI_NUGET_EXE)
  find_program(PRIVATE_AI_NUGET_EXE NAMES nuget nuget.exe)
endif()

if(NOT PRIVATE_AI_NUGET_EXE)
  set(PRIVATE_AI_NUGET_EXE "${_PRIVATE_AI_NUGET_TOOLS_DIR}/nuget.exe")
  if(NOT EXISTS "${PRIVATE_AI_NUGET_EXE}")
    message(STATUS "Downloading nuget.exe to ${PRIVATE_AI_NUGET_EXE}")
    file(DOWNLOAD
      "${_PRIVATE_AI_NUGET_URL}"
      "${PRIVATE_AI_NUGET_EXE}"
      STATUS _private_ai_nuget_dl_status
      SHOW_PROGRESS
    )
    list(GET _private_ai_nuget_dl_status 0 _private_ai_nuget_dl_code)
    if(NOT _private_ai_nuget_dl_code EQUAL 0)
      list(GET _private_ai_nuget_dl_status 1 _private_ai_nuget_dl_msg)
      message(FATAL_ERROR "Failed to download nuget.exe: ${_private_ai_nuget_dl_msg}")
    endif()
  endif()

  file(SHA256 "${PRIVATE_AI_NUGET_EXE}" _PRIVATE_AI_NUGET_HASH)
  if(NOT _PRIVATE_AI_NUGET_HASH STREQUAL _PRIVATE_AI_NUGET_SHA256)
    message(FATAL_ERROR "Integrity check for ${PRIVATE_AI_NUGET_EXE} failed.")
  endif()
endif()

# Mirror into the build dir so plugins that hard-code ${CMAKE_BINARY_DIR}/nuget.exe reuse it.
set(_PRIVATE_AI_NUGET_BUILD_COPY "${CMAKE_BINARY_DIR}/nuget.exe")
if(NOT EXISTS "${_PRIVATE_AI_NUGET_BUILD_COPY}")
  file(COPY "${PRIVATE_AI_NUGET_EXE}" DESTINATION "${CMAKE_BINARY_DIR}")
elseif(NOT PRIVATE_AI_NUGET_EXE STREQUAL _PRIVATE_AI_NUGET_BUILD_COPY)
  file(SHA256 "${_PRIVATE_AI_NUGET_BUILD_COPY}" _PRIVATE_AI_NUGET_BUILD_HASH)
  if(NOT _PRIVATE_AI_NUGET_BUILD_HASH STREQUAL _PRIVATE_AI_NUGET_SHA256)
    file(COPY "${PRIVATE_AI_NUGET_EXE}" DESTINATION "${CMAKE_BINARY_DIR}")
  endif()
endif()

set(PRIVATE_AI_NUGET_EXE "${PRIVATE_AI_NUGET_EXE}" CACHE FILEPATH "Path to nuget.exe" FORCE)
set(NUGET "${PRIVATE_AI_NUGET_EXE}" CACHE FILEPATH "Path to nuget.exe" FORCE)
