# FMD C Compiler

FMD C Compiler 是一个用于 FMD 系列 MCU 工程开发的 VS Code 插件。插件封装厂商 `c.exe` 编译器，并自动生成 VS Code 工程配置，让传统 MCU 工程可以在 VS Code 中编辑、编译、管理输出文件和配置 IntelliSense。

## 功能特性

- 一键编译 FMD MCU 工程
- 编译当前 C 文件
- 清理编译中间文件
- 自动识别 `.prj` 工程文件
- 自动配置编译器路径
- 自动切换目标芯片
- 编译输出默认保存到工程目录下的 `build` 文件夹
- 自动生成 `.vscode/settings.json`
- 自动生成 `.vscode/c_cpp_properties.json`
- 自动生成 `.vscode/fmd_intellisense.h`，用于识别芯片寄存器
- 自动生成/补充 `.gitignore`
- 支持外部烧录工具下载程序到单片机
- 支持 EEPROM 查看、修改、导出

## 适用工程

插件主要面向厂商 CCompiler 工具链工程，例如：

```text
xxx.prj
xxx.C
*.c
*.h
```

默认编译器路径：

```text
C:\Program Files (x86)\CCompiler\Compiler\data\bin\c.exe
```

目标芯片会优先从 `.prj` 文件中的 `Device = ...` 字段自动识别。部分官方工程型号会映射为编译器芯片库中的实际型号，例如 `FT61E13X` 会按官方工具输出映射为 `FT61F13X` 后传给 `c.exe --chip=...`。

## 快速开始

1. 在 VS Code 中打开 MCU 工程目录。
2. 插件会自动搜索 `.prj` 工程文件。
3. 插件会自动生成或更新：

```text
.vscode/settings.json
.vscode/c_cpp_properties.json
.vscode/fmd_intellisense.h
.gitignore
```

4. 按 `F7` 或执行命令：

```text
FMD: Build Project
```

5. 默认输出文件位于：

```text
工程目录\build\xxx.hex
工程目录\build\xxx.bin
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `FMD: Build Project` | 编译整个工程 |
| `FMD: Build Current File` | 编译当前 C 文件 |
| `FMD: Clean Project` | 清理中间文件 |
| `FMD: Select Project (.prj)` | 选择 `.prj` 工程文件 |
| `FMD: Show Build Output` | 打开编译输出面板 |
| `FMD: Set Compiler Path` | 手动设置编译器路径 |
| `FMD: Detect Compiler Path` | 自动检测编译器路径 |
| `FMD: Select Target Chip` | 切换目标芯片 |
| `FMD: Use Chip From Project File` | 从 `.prj` 同步芯片型号 |
| `FMD: Regenerate VS Code Config` | 一键重新生成 VS Code 配置 |
| `FMD: Configure Programmer` | 配置外部烧录工具 |
| `FMD: Download/Program MCU` | 下载程序到单片机 |
| `FMD: Build and Download MCU` | 编译成功后下载 |
| `FMD: Open EEPROM Editor` | 打开 EEPROM 编辑器 |
| `FMD: Read EEPROM From MCU` | 通过外部工具读取 EEPROM |
| `FMD: Write EEPROM To MCU` | 通过外部工具写入 EEPROM |
| `FMD: Export EEPROM HEX` | 导出 EEPROM HEX 文件 |

## 状态栏按钮

插件会在 VS Code 状态栏显示：

| 按钮 | 说明 |
|---|---|
| `FMD Build` | 编译工程 |
| 当前芯片型号 | 切换芯片 |
| `FMD Download` | 下载程序 |
| `FMD Config` | 一键重新生成配置 |

## 自动生成 VS Code 配置

执行以下命令可手动重新生成配置：

```text
FMD: Regenerate VS Code Config
```

该命令会生成或更新：

```text
.gitignore
.vscode/settings.json
.vscode/c_cpp_properties.json
.vscode/fmd_intellisense.h
```

### settings.json

示例：

```json
{
  "fmdCompiler.compilerPath": "C:\\Program Files (x86)\\CCompiler\\Compiler\\data\\bin\\c.exe",
  "fmdCompiler.chip": "从 .prj 的 Device 自动识别，或手动指定",
  "fmdCompiler.projectFile": "C:\\path\\to\\project.prj",
  "fmdCompiler.outputDir": "build",
  "fmdCompiler.autoSaveBeforeBuild": true,
  "fmdCompiler.showOutputOnBuild": true
}
```

### c_cpp_properties.json

插件会自动配置：

```json
{
  "includePath": [
    "${workspaceFolder}/**",
    "工程目录",
    "工程目录/**",
    "C:/Program Files (x86)/CCompiler/Compiler/data/include"
  ],
  "defines": [
    "_当前工程芯片型号",
    "__GCC8PRO__",
    "_CHIP_SELECT_H_"
  ],
  "forcedInclude": [
    "工程目录/.vscode/fmd_intellisense.h"
  ]
}
```

### fmd_intellisense.h

厂商芯片头文件中寄存器通常使用非标准 C 语法，例如：

```c
volatile unsigned char ANSEL0 @ 0x011E;
```

VS Code C/C++ IntelliSense 可能无法识别这些寄存器。插件会自动从当前芯片头文件中抽取寄存器名，生成 IntelliSense 专用头文件：

```text
.vscode/fmd_intellisense.h
```

该文件只用于 VS Code 代码提示，不参与真实 `c.exe` 编译。

## 编译输出目录

默认输出目录为：

```json
"fmdCompiler.outputDir": "build"
```

含义：

```text
工程目录\build\
```

为了兼容官方工具链，插件会先让 `c.exe` 按官方风格输出到工程根目录的小写文件名前缀，例如 `ft61e132a.hex`，编译成功后再把所有编译生成/更新的产物移动到配置输出目录，例如 `build\FT61E132A.hex`、`build\FT61E132A.map`、`build\FT61E132A.lst`、`build\button.p1` 等。

也可以设置为绝对路径，例如：

```json
"fmdCompiler.outputDir": "D:\\firmware-output"
```

如果设置为空字符串，则输出到工程目录。

## 下载程序到单片机

由于不同环境使用的烧录工具不同，插件不内置固定烧录协议，而是通过外部工具适配。

常用配置：

```json
{
  "fmdCompiler.programmerPath": "C:\\path\\to\\programmer.exe",
  "fmdCompiler.programmerArgs": [
    "--chip", "${chip}",
    "--file", "${hexFile}",
    "--program"
  ],
  "fmdCompiler.downloadFileType": "hex"
}
```

支持变量：

| 变量 | 含义 |
|---|---|
| `${chip}` | 当前芯片型号 |
| `${projectFile}` | 当前 `.prj` 文件 |
| `${projectDir}` | 工程目录 |
| `${projectName}` | 工程名 |
| `${compilerPath}` | 编译器路径 |
| `${hexFile}` | HEX 输出文件 |
| `${binFile}` | BIN 输出文件 |
| `${downloadFile}` | 当前选择的下载文件 |
| `${workspaceFolder}` | VS Code 工作区目录 |

## EEPROM 功能

插件提供 EEPROM 编辑器，可查看和修改 EEPROM 镜像数据。

默认 EEPROM 配置：

```json
{
  "fmdCompiler.eepromBaseAddress": "0x2100",
  "fmdCompiler.eepromStart": "0x00",
  "fmdCompiler.eepromSize": 112,
  "fmdCompiler.eepromFill": "0xFF"
}
```

插件会优先从 `.map` 文件解析 EEPROM 区域，例如：

```text
-AEEDATA=00h-06Fh/02100h
```

EEPROM 硬件读取/写入同样通过外部烧录工具命令实现。

## 自动生成 .gitignore

插件会自动生成/补充 `.gitignore`，屏蔽常见 MCU 编译产物和临时文件，例如：

```gitignore
.vscode
**/*.as
**/*.asm
**/*.bin
**/*.hex
**/*.obj
**/*.p1
**/*.pre
**/*.map
**/*.lst
**/*.ini
**/*.zip
**/*.rar
```

如果已有 `.gitignore`，插件只会补充 FMD 生成块，不会删除用户已有内容。

## 常见问题

### 1. 找不到 `SYSCFG.h`

执行：

```text
FMD: Regenerate VS Code Config
```

插件会重新生成 `c_cpp_properties.json`，加入编译器 include 路径。

### 2. `ANSEL0`、`TRISA` 等寄存器未定义

执行：

```text
FMD: Regenerate VS Code Config
```

插件会重新生成 `fmd_intellisense.h` 并配置 `forcedInclude`。

如果红线仍未消失，执行：

```text
C/C++: Reset IntelliSense Database
```

然后 Reload Window。

### 3. 没有输出到 build 文件夹

确认当前工程的 `.vscode/settings.json` 中存在：

```json
"fmdCompiler.outputDir": "build"
```

也可以执行：

```text
FMD: Regenerate VS Code Config
```

### 4. 编译提示芯片不在 gcc8.ini 中

如果输出类似：

```text
chip "FT61E13X" not present in chipinfo file "...gcc8.ini"
```

说明插件已经从 `.prj` 的 `Device` 字段识别出了芯片，但当前安装的 CCompiler 芯片数据库不支持该型号。插件会尝试从历史 `.map` 的 `Machine type is ...` 和内置别名规则推导实际编译器芯片名，例如 `FT61E13X -> FT61F13X`。如果仍失败，请确认：

- 是否安装了支持该芯片的新版本 CCompiler
- `.prj` 中的 `Device = ...` 是否写成了官方工具支持的芯片名
- `fmdCompiler.compilerPath` 是否指向正确的 CCompiler 安装目录

### 5. 下载功能不能直接使用

需要先配置实际使用的外部烧录工具路径和参数：

```text
FMD: Configure Programmer
```

## 开发与打包

安装依赖：

```bash
npm install
```

编译：

```bash
npm run compile
```

打包：

```bash
npx @vscode/vsce package --allow-missing-repository
```

## License

MIT
