# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['D:\\Claude\\99.Tools\\unified_workbench\\bridge\\bridge_server.py'],
    pathex=['D:\\Claude\\99.Tools\\unified_workbench\\bridge\\_build_stage'],
    binaries=[],
    datas=[],
    hiddenimports=['convert_core', 'eiass_doc_resolver', 'hwp2pdf_core', 'hwp_pagenum', 'chardet', 'pdfplumber', 'fitz', 'docx', 'openpyxl', 'pandas', 'numpy', 'PIL', 'bs4', 'requests', 'win32com', 'win32com.client', 'pythoncom', 'pywintypes', 'win32print'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'torchvision', 'easyocr', 'scipy', 'sklearn', 'matplotlib', 'geopandas', 'shapely'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='EIAWorkbenchBridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
