# Disassemble flutter_windows.dll around crash RVA 0x14f37
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

DLL = r"D:\flutter\bin\cache\artifacts\engine\windows-x64\flutter_windows.dll"
CRASH_RVA = 0x14F37
START = 0x14EE0
END = 0x15060

pe = pefile.PE(DLL, fast_load=True)
pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXPORT']])
exports = {}
if hasattr(pe, "DIRECTORY_ENTRY_EXPORT"):
    for sym in pe.DIRECTORY_ENTRY_EXPORT.symbols:
        if sym.name and sym.address:
            exports[sym.address] = sym.name.decode("utf-8", "replace")

data = pe.get_memory_mapped_image()
code = bytes(data[START:END])

md = Cs(CS_ARCH_X86, CS_MODE_64)
md.detail = False

print(f"crash RVA 0x{CRASH_RVA:x}")
for insn in md.disasm(code, START):
    mark = "  <<< CRASH" if insn.address <= CRASH_RVA < insn.address + insn.size else ""
    tgt = ""
    if insn.mnemonic in ("call", "jmp") and insn.op_str.startswith("0x"):
        try:
            t = int(insn.op_str, 16)
            if t in exports:
                tgt = f"   ; -> {exports[t]}"
        except ValueError:
            pass
    raw = " ".join(f"{b:02x}" for b in insn.bytes)
    print(f"0x{insn.address:06x}: {raw:<24} {insn.mnemonic:<8} {insn.op_str}{tgt}{mark}")

print("\n--- exports in range ---")
for addr, name in sorted(exports.items()):
    if START - 0x200 <= addr <= END + 0x200:
        print(f"0x{addr:06x} {name}")
