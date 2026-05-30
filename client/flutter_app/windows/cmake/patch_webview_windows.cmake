# webview_windows uses DEPENDS with add_custom_command(TARGET), which CMake 3.31+ warns about.
set(_WV_PLUGIN_CMAKE
  "${CMAKE_CURRENT_SOURCE_DIR}/flutter/ephemeral/.plugin_symlinks/webview_windows/windows/CMakeLists.txt")
if(NOT EXISTS "${_WV_PLUGIN_CMAKE}")
  return()
endif()

file(READ "${_WV_PLUGIN_CMAKE}" _WV_PLUGIN_CONTENT)
string(FIND "${_WV_PLUGIN_CONTENT}" "DEPENDS \${NUGET}" _WV_DEPENDS_POS)
if(_WV_DEPENDS_POS EQUAL -1)
  return()
endif()

string(REGEX REPLACE "  DEPENDS \\$\\{NUGET\\}\r?\n" "" _WV_PLUGIN_CONTENT "${_WV_PLUGIN_CONTENT}")
file(WRITE "${_WV_PLUGIN_CMAKE}" "${_WV_PLUGIN_CONTENT}")
