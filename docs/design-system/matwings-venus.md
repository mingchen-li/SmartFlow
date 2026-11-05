# MatwingsVenus DS 组件详细规范

> 来源：Figma 文件 `MatwingsVenus-DS`  
> 链接：https://www.figma.com/design/5jS55ecngalCPsCNiMflT0/MatwingsVenus-DS?node-id=0-1  
> 整理日期：2026-09-07  
> 说明：本文档仅根据 Figma 文件中的变量、组件集、组件属性和展示页文字整理；未在 Figma 中新建或修改任何内容。

---

## 1. 设计系统概览

### 1.1 文件结构

| Page | 内容 | 说明 |
| --- | --- | --- |
| `Design System` | 规范展示页 | 包含 `MatwingsVenus DS / Overview`、`Basic Components`、`Composite Components` |
| `Component Templates / Source` | 组件源文件 | 包含基础组件、复合组件、图标组件和插槽组件 |

### 1.2 变量集合

| Collection | Mode | 变量数量 | 说明 |
| --- | --- | ---: | --- |
| `Frontend Tokens` | `Light` | 54 | 当前设计系统的前端变量来源 |

### 1.3 设计系统组织关系

```text
Frontend Tokens
  ↓
基础组件：Button / Input / Select / Checkbox / Radio / Badge / Switch ...
  ↓
复合组件：Sidebar / Tabs / File Item / Drawer / Steps / Collapse ...
  ↓
业务页面与产品功能模块
```

### 1.4 当前提取结论

- 当前文件已建立一套 `Light` 模式变量，暂未发现 Dark mode。
- 当前文件未提取到本地 Text Styles、Paint Styles、Effect Styles、Grid Styles。
- 组件规范主要通过 Figma Variables、Component Set、Variant Property、Boolean Property、Text Property 和 Slot 表达。
- 基础组件状态覆盖较完整，尤其是 Button、Input、Checkbox、Switch、File Item、Collapse。

---

## 2. 设计变量

### 2.1 品牌色

| Token | 值 | 用途 |
| --- | --- | --- |
| `color/brand/primary` | `#3572FF` | 主按钮、链接、信息强调 |
| `color/brand/primary-hover` | `#5990FF` | 主按钮悬停态 |
| `color/brand/primary-active` | `#2150D2` | 主按钮按下态、选中态 |
| `color/brand/primary-bg` | `#F5F9FF` | 主色浅背景、选中背景、浅提示底 |
| `color/brand/primary-border` | `#A0C6FF` | 主色边框、强调边界 |
| `color/brand/arcoblue-2` | `#C4DEFF` | 品牌蓝浅色色阶 |
| `color/brand/arcoblue-4` | `#7DACFF` | 品牌蓝中浅色色阶 |
| `color/brand/arcoblue-8` | `#1134A6` | 品牌蓝深色色阶 |
| `color/brand/arcoblue-9` | `#061D79` | 品牌蓝更深色色阶 |
| `color/brand/arcoblue-10` | `#000D4D` | 品牌蓝最深色色阶 |

### 2.2 文本色

| Token | 值 | 用途 |
| --- | --- | --- |
| `color/text/gray-950` | `#242428` | 主文本、标题、重要信息 |
| `color/text/gray-500` | `#8A8A97` | 次级正文、说明、占位符、元信息 |
| `color/text/gray-0` | `#FFFFFF` | 深色背景或主色背景上的反白文字 |

### 2.3 背景与容器

| Token | 值 | 用途 |
| --- | --- | --- |
| `color/surface/white` | `#FFFFFF` | 页面底色、卡片、弹窗、浮层 |
| `color/surface/gray-25` | `#FAFAFB` | 最浅填充、表格底、弱背景 |
| `color/surface/gray-50` | `#F6F6F7` | 默认填充、hover 背景、次级背景 |
| `color/surface/gray-100` | `#E8EAED` | 较深弱背景、弱分隔层 |
| `color/surface/tooltip` | `#0F172B` | Tooltip 等深色提示浮层 |

### 2.4 语义、状态与遮罩

| Token | 值 | 用途 |
| --- | --- | --- |
| `color/semantic/success` | `#12B76A` | 成功、完成、已确认 |
| `color/semantic/warning` | `#F59E0B` | 警告、需注意 |
| `color/semantic/destructive` | `#E7000B` | 错误、危险、删除 |
| `color/status/success-bg` | `#E8F8F0` | 成功浅背景 |
| `color/status/warning-bg` | `#FFF4D6` | 警告浅背景 |
| `color/status/destructive-bg` | `#FFE8E9` | 错误浅背景 |
| `color/state/ring` | `#3572FF / 36%` | 默认焦点环 |
| `color/state/destructive-ring` | `#E7000B / 20%` | 错误焦点环 |
| `color/overlay/overlay` | `#000000 / 50%` | 弹窗、抽屉遮罩 |

### 2.5 边框与业务角色色

| Token | 值 | 用途 |
| --- | --- | --- |
| `color/border/gray-200` | `#E8E8EC` | 默认边框 |
| `color/border/divider` | `#E8E8EC / 50%` | 分割线 |
| `color/role/protein-purple` | `#8B5CF6` | 蛋白质/生物业务强调 |
| `color/role/bio-cyan` | `#06B6D4` | 生物/实验业务强调 |
| `color/role/protein-bg` | `#F5F3FF` | 蛋白质相关浅背景 |

### 2.6 圆角

| Token | 值 | 典型用途 |
| --- | ---: | --- |
| `radius/radius-xs` | 4 | Checkbox、Badge、小型控件 |
| `radius/radius-md` | 8 | Button、Input、Select、Textarea |
| `radius/radius-lg` | 12 | Card、Popover、DropdownMenu |
| `radius/radius-xl` | 16 | Dialog、Drawer、大型面板 |
| `radius/radius-2xl` | 24 | 强调容器、大型视觉模块 |
| `radius/radius-full` | 9999 | Avatar、圆形按钮、胶囊标签 |

### 2.7 间距

| Token | 值 | 建议用途 |
| --- | ---: | --- |
| `spacing/spacing-1` | 4 | 极小间距、紧凑元素内距 |
| `spacing/spacing-2` | 6 | 图标与文字间距 |
| `spacing/spacing-3` | 8 | 表单内部间距、小控件 padding |
| `spacing/spacing-4` | 12 | 紧凑列表、按钮 sm 横向 padding |
| `spacing/spacing-5` | 16 | 默认组件间距、按钮 default 横向 padding |
| `spacing/spacing-6` | 20 | 中等容器间距 |
| `spacing/spacing-7` | 24 | 大按钮、表单分组、卡片内距 |
| `spacing/spacing-8` | 32 | 页面模块间距 |
| `spacing/spacing-9` | 48 | 大型展示区块间距 |

### 2.8 字号

| Token | 值 | 建议用途 |
| --- | ---: | --- |
| `font/font-size-1` | 12 | 辅助文字、Badge、小提示 |
| `font/font-size-2` | 14 | 默认正文、按钮、输入框、菜单项 |
| `font/font-size-3` | 16 | 强调正文、较大控件 |
| `font/font-size-4` | 20 | 小标题、卡片标题 |
| `font/font-size-5` | 24 | 页面标题 |
| `font/font-size-6` | 28 | 大标题 |
| `font/font-size-7` | 40 | 展示页主标题 |

---

## 3. 基础组件详细规范

### 3.1 Button

Button 是系统中的主要操作组件，用于提交、保存、创建、删除、切换低强调操作或承载纯图标操作。该组件集包含 79 个变体，覆盖文本按钮、左图标按钮、纯图标按钮、多尺寸和主要交互状态。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Variant` | Variant | `default` | `default` / `destructive` / `outline` / `secondary` / `ghost` / `link` / `icon` |
| `Size` | Variant | `sm` | `default` / `sm` / `lg` / `icon` / `icon-sm` / `icon-lg` |
| `State` | Variant | `Default` | `Default` / `Hover` / `Disabled` / `Loading` |
| `Show Icon` | Boolean | `true` | `true` / `false` |

| Size | 高度 | 说明 |
| --- | ---: | --- |
| `sm` | 32px | 表格内、紧凑区域、低密度操作 |
| `default` | 36px | 常规表单、页面通用操作 |
| `lg` | 40px | 主要提交、强调 CTA |
| `icon-sm` | 28x28px | 紧凑纯图标按钮 |
| `icon` | 32x32px | 默认纯图标按钮 |
| `icon-lg` | 40x40px | 大尺寸纯图标按钮 |

**状态规则**：Default 为默认可点击状态；Hover 体现悬停反馈；Disabled 不可点击并降低透明度；Loading 显示加载圆环且不可点击，透明度与 Disabled 保持一致。`link` 变体 Hover 使用下划线强化链接属性。圆角使用 8px。

**变量映射**：

| Variant / State | 背景 | 文字 | 边框 | 其他 |
| --- | --- | --- | --- | --- |
| `default / Default` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | 圆角 `radius/radius-md` |
| `default / Hover` | `color/brand/primary-hover` | `color/text/gray-0` | `color/brand/primary-hover` | cursor pointer |
| `default / Disabled` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | opacity 50%，不可点击 |
| `default / Loading` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | opacity 与 Disabled 一致，显示 spinner |
| `destructive / Default` | `color/semantic/destructive` | `color/text/gray-0` | `color/semantic/destructive` | 用于删除、危险操作 |
| `destructive / Hover` | `color/semantic/destructive` | `color/text/gray-0` | `color/semantic/destructive` | 可通过透明度或加深效果表达 hover |
| `outline / Default` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` | 轻量操作 |
| `outline / Hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/border/gray-200` | hover 浅灰背景 |
| `secondary / Default` | `color/surface/gray-50` | `color/text/gray-950` | `color/surface/gray-50` | 次级操作 |
| `secondary / Hover` | `color/surface/gray-100` | `color/text/gray-950` | `color/surface/gray-100` | 增强背景层级 |
| `ghost / Default` | transparent | `color/text/gray-950` | transparent | 低强调操作 |
| `ghost / Hover` | `color/surface/gray-50` | `color/text/gray-950` | transparent | hover 显示浅背景 |
| `link / Default` | transparent | `color/brand/primary` | transparent | 文本链接 |
| `link / Hover` | transparent | `color/brand/primary-hover` | transparent | 显示下划线 |
| `icon / Default` | transparent 或 `color/surface/white` | `color/text/gray-950` | transparent | 图标尺寸 16px |
| `icon / Hover` | `color/surface/gray-50` | `color/text/gray-950` | transparent | 圆角 `radius/radius-md` |

### 3.2 Badge

Badge 用于小面积状态标识、分类标签、计数辅助信息和结果状态提示。组件包含 10 个变体，支持状态类型、尺寸和图标显隐。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Variant` | Variant | `info` | `success` / `warning` / `destructive` / `info` / `neutral` |
| `Size` | Variant | `default` | `default` / `sm` |
| `Show icon` | Boolean | `true` | `true` / `false` |

**使用规则**：`info` 用于常规信息提示；`success` 用于成功/完成状态；`warning` 用于需注意状态；`destructive` 用于失败/错误状态；`neutral` 用于普通弱强调标签。小尺寸用于表格、列表和紧凑卡片，默认尺寸用于卡片头部或模块说明。

**变量映射**：

| Variant | 背景 | 文字 / 图标 | 边框 |
| --- | --- | --- | --- |
| `info` | `color/brand/primary-bg` | `color/brand/primary` | `color/brand/primary-border` |
| `success` | `color/status/success-bg` | `color/semantic/success` | `color/status/success-bg` |
| `warning` | `color/status/warning-bg` | `color/semantic/warning` | `color/status/warning-bg` |
| `destructive` | `color/status/destructive-bg` | `color/semantic/destructive` | `color/status/destructive-bg` |
| `neutral` | `color/surface/gray-50` | `color/text/gray-500` | `color/border/gray-200` |

### 3.3 Input

Input 用于单行文本输入。组件包含 10 个变体，覆盖基础输入、前置图标、后置图标、前后图标组合和可清空输入。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Focus` / `Filled` / `Disabled` / `Error` |
| `Extra` | Variant | `Text Only` | `Text Only` / `Prefix` / `Suffix` / `Prefix + Suffix` / `Clearable` |
| `Prefix Icon` | Boolean | `false` | `true` / `false` |
| `Suffix Icon` | Boolean | `false` | `true` / `false` |
| `Clearable` | Boolean | `false` | `true` / `false` |
| `Text` | Text | `Placeholder` | 自定义输入文字 |

**状态规则**：Default 显示占位符；Hover 增强边框反馈；Focus 使用 2px 主色焦点环；Filled 显示输入值；Disabled 禁止输入并弱化文字和背景；Error 使用错误边框与错误焦点环。默认高度为 36px，圆角为 8px。

**变量映射**：

| State | 背景 | 文字 | Placeholder | 边框 | Ring |
| --- | --- | --- | --- | --- | --- |
| `Default` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/border/gray-200` | - |
| `Hover` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/brand/primary-border` | - |
| `Focus` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/brand/primary` | `color/state/ring` |
| `Filled` | `color/surface/white` | `color/text/gray-950` | - | `color/border/gray-200` | - |
| `Disabled` | `color/surface/gray-50` | `color/text/gray-500` | `color/text/gray-500` | `color/border/gray-200` | - |
| `Error` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/semantic/destructive` | `color/state/destructive-ring` |

### 3.4 Radio

Radio 用于单选场景，一组互斥选项中只能选择一个。组件包含带标签和不带标签两类结构。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Unchecked` | `Unchecked` / `Hover` / `Checked` / `Disabled Unchecked` / `Disabled Checked` |
| `Label` | Variant | `True` | `True` / `False` |
| `Label` | Boolean | `true` | `true` / `false` |
| `Text` | Text | `Radio` | 自定义标签 |

**状态规则**：Unchecked 为未选中；Hover 展示悬停反馈；Checked 展示选中圆点；Disabled Unchecked 与 Disabled Checked 保留状态可见性但不可操作。当前组件未配置 Focus 变体，前端实现时仍应保留键盘焦点态。

**变量映射**：

| State | 控件背景 | 标记 / 圆点 | 边框 | Label |
| --- | --- | --- | --- | --- |
| `Unchecked` | `color/surface/white` | - | `color/border/gray-200` | `color/text/gray-950` |
| `Hover` | `color/surface/white` 或 `color/brand/primary-bg` | - | `color/brand/primary-border` | `color/text/gray-950` |
| `Checked` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | `color/text/gray-950` |
| `Disabled Unchecked` | `color/surface/gray-50` | - | `color/border/gray-200` | `color/text/gray-500` |
| `Disabled Checked` | `color/surface/gray-100` | `color/text/gray-500` | `color/border/gray-200` | `color/text/gray-500` |

### 3.5 Checkbox

Checkbox 用于多选、批量选择和布尔选项。组件包含 12 个变体，支持未选、悬停、选中、半选和禁用状态。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Unchecked` | `Unchecked` / `Hover` / `Checked` / `Indeterminate` / `Disabled Unchecked` / `Disabled Checked` |
| `Label` | Variant | `True` | `True` / `False` |
| `Label` | Boolean | `true` | `true` / `false` |
| `Text` | Text | `Checkbox` | 自定义标签 |

**状态规则**：Indeterminate 用于父级项仅部分子项被选中的情况；Disabled 状态需要保留选中或未选中的视觉状态。当前组件未配置 Focus 变体，前端应补足可访问焦点反馈。

**变量映射**：

| State | 控件背景 | 标记 | 边框 | Label |
| --- | --- | --- | --- | --- |
| `Unchecked` | `color/surface/white` | - | `color/border/gray-200` | `color/text/gray-950` |
| `Hover` | `color/surface/white` 或 `color/brand/primary-bg` | - | `color/brand/primary-border` | `color/text/gray-950` |
| `Checked` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | `color/text/gray-950` |
| `Indeterminate` | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` | `color/text/gray-950` |
| `Disabled Unchecked` | `color/surface/gray-50` | - | `color/border/gray-200` | `color/text/gray-500` |
| `Disabled Checked` | `color/surface/gray-100` | `color/text/gray-500` | `color/border/gray-200` | `color/text/gray-500` |

### 3.6 Switch

Switch 用于二元开关设置，例如开启/关闭能力、启用/停用配置。组件包含 16 个变体，覆盖尺寸、开关值、禁用态和标签显隐。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Size` | Variant | `default` | `default` / `sm` |
| `Checked` | Variant | `false` | `false` / `true` |
| `State` | Variant | `Default` | `Default` / `Disabled` |
| `Label` | Variant | `false` | `false` / `true` |

**使用规则**：用于即时生效或明确保存的设置项。Checked 表示开启，false 表示关闭；Disabled 状态保留当前开关值但不可操作。带 Label 时应让文字说明和开关形成同一点击区域。

**变量映射**：

| Checked / State | 轨道 | 圆点 | Label |
| --- | --- | --- | --- |
| `false / Default` | `color/surface/gray-100` | `color/surface/white` | `color/text/gray-950` |
| `true / Default` | `color/brand/primary` | `color/surface/white` | `color/text/gray-950` |
| `false / Disabled` | `color/surface/gray-50` | `color/surface/white` | `color/text/gray-500` |
| `true / Disabled` | `color/brand/primary` + opacity 50% | `color/surface/white` | `color/text/gray-500` |

### 3.7 Card

Card 用于承载信息分组、数据摘要、表单片段或可复用内容块。组件为单组件，包含多个布尔属性和内容插槽。

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `Show Icon` | Boolean | `true` | 控制头部图标显示 |
| `Show Badge` | Boolean | `true` | 控制头部状态徽章显示 |
| `Show Slot` | Boolean | `true` | 控制内容插槽显示 |
| `Slot` | Slot | - | 承载业务内容 |

```text
Card
├── Header：图标 / 标题 / 状态 Badge / 操作图标
├── Divider
└── Content Slot：文本、数据摘要或表单
```

**使用规则**：Card 示例尺寸为 400x214px。头部适合展示模块名称、状态和快捷操作，内容区由 Slot 承载具体业务，不建议为每种业务内容新建独立卡片组件。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 / 分割线 |
| --- | --- | --- | --- |
| 容器 | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| Header | `color/surface/white` | 标题 `color/text/gray-950`，说明 `color/text/gray-500` | - |
| Divider | - | - | `color/border/divider` |
| Content Slot | `color/surface/white` | `color/text/gray-950` | - |

### 3.8 Dialog

Dialog 用于需要用户确认、填写或处理的模态任务。组件包含标题、描述、内容区、底部操作按钮和右上角关闭按钮。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` |

**使用规则**：关闭按钮使用 Button 的 ghost icon close 形态，Hover 时显示灰色背景。Dialog 应配合 `color/overlay/overlay` 作为遮罩，并在前端实现中保证焦点陷阱、Esc 关闭和键盘可访问性。

**变量映射**：

| 部位 / State | 背景 | 文字 | 边框 / 遮罩 |
| --- | --- | --- | --- |
| Overlay | `color/overlay/overlay` | - | - |
| Content | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| Description | - | `color/text/gray-500` | - |
| Close Default | transparent | `color/text/gray-500` | transparent |
| Close Hover | `color/surface/gray-50` | `color/text/gray-950` | transparent |

### 3.9 Tooltip

Tooltip 用于短文本解释、图标说明和轻量辅助提示。组件支持四个方向。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Side` | Variant | `Top` | `Top` / `Right` / `Bottom` / `Left` |

**使用规则**：背景使用 `color/surface/tooltip`，文字使用白色或反白文本。内容应简短，不承载复杂交互。方向由触发元素位置决定，避免遮挡关键内容。

**变量映射**：

| 部位 | 背景 | 文字 | 其他 |
| --- | --- | --- | --- |
| Tooltip body | `color/surface/tooltip` | `color/text/gray-0` | 圆角 `radius/radius-md` |
| Arrow | `color/surface/tooltip` | - | 跟随 `Side` 定位 |

### 3.10 Select

Select 用于从有限选项中选择单项。组件包含触发器和打开态下拉面板。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Focus` / `Disabled` / `Open` |

**状态规则**：Default 展示当前值或占位符；Hover 强化边界反馈；Focus 使用 2px 焦点环；Disabled 禁止打开；Open 展示下拉面板并支持分割线分组。触发器示例尺寸为 280x44px。

**变量映射**：

| State | 触发器背景 | 文字 | 图标 | 边框 | Ring / 面板 |
| --- | --- | --- | --- | --- | --- |
| `Default` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/border/gray-200` | - |
| `Hover` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-950` | `color/brand/primary-border` | - |
| `Focus` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-950` | `color/brand/primary` | `color/state/ring` |
| `Disabled` | `color/surface/gray-50` | `color/text/gray-500` | `color/text/gray-500` | `color/border/gray-200` | 不可打开 |
| `Open` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-950` | `color/brand/primary` | 面板背景 `color/surface/white`，分割线 `color/border/divider` |

### 3.11 Textarea

Textarea 用于多行文本输入，适合备注、说明、反馈等长文本场景。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Focus` / `Filled` / `Disabled` / `Error` |

**状态规则**：Focus 使用 2px 主色焦点环；Filled 无焦点环；Error 使用错误边框和错误焦点环；Disabled 不可编辑。示例尺寸为 320x80px。

**变量映射**：

| State | 背景 | 文字 | Placeholder | 边框 | Ring |
| --- | --- | --- | --- | --- | --- |
| `Default` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/border/gray-200` | - |
| `Hover` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/brand/primary-border` | - |
| `Focus` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/brand/primary` | `color/state/ring` |
| `Filled` | `color/surface/white` | `color/text/gray-950` | - | `color/border/gray-200` | - |
| `Disabled` | `color/surface/gray-50` | `color/text/gray-500` | `color/text/gray-500` | `color/border/gray-200` | - |
| `Error` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | `color/semantic/destructive` | `color/state/destructive-ring` |

### 3.12 Label

Label 用于表单字段名称、设置项名称和输入控件说明。组件支持普通和必填状态。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Required` |

**使用规则**：Required 状态用于必填字段，应在文字旁提供明显必填标记。Label 应与对应输入控件建立可访问关联。

**变量映射**：

| State | 背景 | 文字 | 其他 |
| --- | --- | --- | --- |
| `Default` | transparent | `color/text/gray-950` | - |
| `Required` | transparent | `color/text/gray-950` | 必填标记 `color/semantic/destructive` |

### 3.13 Label/Form

Label/Form 是表单标签组合组件，用于将字段标题、说明或错误提示组织成稳定结构。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| 无显式属性 | - | - | - |

**使用规则**：适合在表单项中复用，前端实现时应与 FormItem、FormMessage、FormDescription 等结构保持一致，确保错误状态和必填标记可统一管理。

**变量映射**：

| 部位 | 背景 | 文字 | 状态 |
| --- | --- | --- | --- |
| Label | transparent | `color/text/gray-950` | 必填标记用 `color/semantic/destructive` |
| Description | transparent | `color/text/gray-500` | - |
| Error Message | transparent | `color/semantic/destructive` | Error 状态展示 |

---

## 4. 复合组件详细规范

### 4.1 Radio Card

Radio Card 是卡片式单选项，用于需要展示标题、说明或附加信息的单选场景。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Unchecked` | `Unchecked` / `Hover` / `Checked` / `Disabled Checked` |

**使用规则**：相比普通 Radio，Radio Card 更适合方案选择、套餐选择、实验参数选项等信息密度较高的互斥选择。Checked 状态应通过边框、背景或单选标记共同表达。

**变量映射**：

| State | 背景 | 文字 | 边框 / 指示 |
| --- | --- | --- | --- |
| `Unchecked` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/brand/primary-border` |
| `Checked` | `color/brand/primary-bg` | `color/text/gray-950` | `color/brand/primary` |
| `Disabled Checked` | `color/surface/gray-50` | `color/text/gray-500` | `color/border/gray-200` |

### 4.2 Checkbox Card

Checkbox Card 是卡片式复选项，用于可多选且需要承载说明信息的选项。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Unchecked` | `Unchecked` / `Hover` / `Checked` / `Indeterminate` / `Disabled Checked` |

**使用规则**：适用于多文件、多模块、多能力选择。Indeterminate 用于分组半选。Disabled Checked 表示该选项已选但当前不可变更。

**变量映射**：

| State | 背景 | 文字 | 边框 / 指示 |
| --- | --- | --- | --- |
| `Unchecked` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/brand/primary-border` |
| `Checked` | `color/brand/primary-bg` | `color/text/gray-950` | `color/brand/primary` |
| `Indeterminate` | `color/brand/primary-bg` | `color/text/gray-950` | `color/brand/primary-border` |
| `Disabled Checked` | `color/surface/gray-50` | `color/text/gray-500` | `color/border/gray-200` |

### 4.3 Alert

Alert 用于页面内提示、状态反馈和局部信息提醒。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Status` | Variant | `Success` | `Info` / `Success` / `Warning` / `Error` |

**使用规则**：Info 映射主色；Success 映射成功色；Warning 映射警告色；Error 映射错误色。Alert 适合常驻展示，不应替代 Toast 的临时反馈。

**变量映射**：

| Status | 背景 | 文字 / 图标 | 边框 |
| --- | --- | --- | --- |
| `Info` | `color/brand/primary-bg` | `color/brand/primary` | `color/brand/primary-border` |
| `Success` | `color/status/success-bg` | `color/semantic/success` | `color/status/success-bg` |
| `Warning` | `color/status/warning-bg` | `color/semantic/warning` | `color/status/warning-bg` |
| `Error` | `color/status/destructive-bg` | `color/semantic/destructive` | `color/status/destructive-bg` |

### 4.4 Progress

Progress 用于任务进度、上传进度或流程完成度展示。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Value` | Variant | `25` | `25` / `50` / `75` |

**使用规则**：Figma 中提供 25、50、75 三个示例值；前端实现应支持 0-100 的连续值，并对超出范围值做 clamp。

**变量映射**：

| 部位 | 变量 |
| --- | --- |
| 轨道 | `color/brand/primary-bg` |
| 进度填充 | `color/brand/primary` |
| 数值文字 | `color/text/gray-950` 或 `color/text/gray-500` |

### 4.5 Pagination

Pagination 用于长列表或表格分页浏览。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Variant` | Variant | `Default` | `Default` / `Full` |

**使用规则**：Default 仅展示基础页码；Full 展示总数、每页条数和跳页输入。页码较多时使用省略号折叠中间页码。

**变量映射**：

| State | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Default | transparent | `color/text/gray-950` | `color/border/gray-200` |
| Hover | `color/surface/gray-50` | `color/brand/primary` | `color/brand/primary-border` |
| Active | `color/brand/primary` | `color/text/gray-0` | `color/brand/primary` |
| Disabled | `color/surface/gray-50` | `color/text/gray-500` | `color/border/gray-200` |

### 4.6 Slider

Slider 用于连续或分段数值调节，例如比例、强度、阈值、进度选择。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Value` | Variant | `25` | `25` / `50` / `75` |

**使用规则**：Figma 提供 25、50、75 三个状态示例；前端可扩展为连续数值。需要提供键盘可访问操作和当前值语义。

**变量映射**：

| 部位 | 变量 |
| --- | --- |
| 轨道 | `color/surface/gray-100` |
| 已选范围 | `color/brand/primary` |
| 滑块 | `color/surface/white` |
| 滑块边框 / focus | `color/brand/primary` / `color/state/ring` |

### 4.7 Sidebar

Sidebar 是产品主导航容器，用于承载品牌、导航分组、导航项、底部用户信息等。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Expanded` | `Expanded` / `Collapsed` |

**使用规则**：Expanded 示例宽度为 280px，Collapsed 示例宽度为 96px。单行导航项默认高度为 36px。Profile / Avatar 区域位于底部，导航分组与导航项通过子组件组织。

**变量映射**：

| State | 背景 | 文字 | 图标 | 其他 |
| --- | --- | --- | --- | --- |
| `Expanded` | `color/surface/white` | `color/text/gray-950` | `color/text/gray-500` | 分组分隔可用 `color/border/divider` |
| `Collapsed` | `color/surface/white` | - | `color/text/gray-500` | 宽度收起至 96px |

### 4.8 Sidebar Item

Sidebar Item 是侧边栏中的单个导航项。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Active` / `Collapsed` |
| `Show Icon` | Boolean | `true` | `true` / `false` |
| `Icon / navigation` | Slot | - | 导航图标插槽 |
| `Action / More` | Slot | - | 右侧更多操作插槽 |

**状态规则**：Default 为普通导航项；Hover 显示浅背景反馈；Active 表示当前页面；Collapsed 仅保留图标或紧凑表达。右侧操作不应抢占主导航点击区域。

**变量映射**：

| State | 背景 | 文字 | 图标 | 其他 |
| --- | --- | --- | --- | --- |
| `Default` | transparent | `color/text/gray-950` | `color/text/gray-500` | - |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/text/gray-950` | 圆角 `radius/radius-md` |
| `Active` | `color/brand/primary-bg` | `color/brand/primary` | `color/brand/primary` | 可增加左侧 active 指示 |
| `Collapsed` | transparent | - | `color/text/gray-500` | 仅展示图标 |

### 4.9 Sidebar Group

Sidebar Group 用于组织侧边栏中的一组导航项。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Expanded` | `Expanded` / `Collapsed` |

**使用规则**：Expanded 展示组标题与子项；Collapsed 收起子项或简化为图标导航。适合区分主导航、设置、实验流程等一级分组。

**变量映射**：

| 部位 / State | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Group title | transparent | `color/text/gray-500` | - |
| Expanded content | transparent | `color/text/gray-950` | 可用 `color/border/divider` |
| Collapsed | transparent | - | - |

### 4.10 Toast

Toast 用于轻量、短时、全局反馈。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Status` | Variant | `Success` | `Success` / `Warning` / `Error` / `Loading` |

**使用规则**：Success 表示操作成功；Warning 表示存在风险或需注意；Error 表示失败；Loading 表示任务处理中。Toast 应自动消失或在 Loading 完成后切换为结果状态。

**变量映射**：

| Status | 背景 | 文字 / 图标 | 边框 |
| --- | --- | --- | --- |
| `Success` | `color/surface/white` | `color/semantic/success` | `color/border/gray-200` |
| `Warning` | `color/surface/white` | `color/semantic/warning` | `color/border/gray-200` |
| `Error` | `color/surface/white` | `color/semantic/destructive` | `color/border/gray-200` |
| `Loading` | `color/surface/white` | `color/brand/primary` | `color/border/gray-200` |

### 4.11 Empty

Empty 用于无数据、搜索无结果、初始空白状态等场景。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Type` | Variant | `Default` | `Default` / `Search` |

**使用规则**：Default 用于通用空状态；Search 用于搜索无结果。建议配合简短说明和可执行的下一步操作。

**变量映射**：

| Type | 背景 | 文字 | 图标 / 插画 |
| --- | --- | --- | --- |
| `Default` | transparent | `color/text/gray-500` | `color/surface/gray-100` |
| `Search` | transparent | `color/text/gray-500` | `color/surface/gray-100` |

### 4.12 MetricLabel / default

MetricLabel 用于指标、数值摘要和数据看板中的关键标签展示。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| 无显式属性 | - | - | - |

**使用规则**：适合放置在 Card 或数据模块中，用于展示指标名、数值、变化趋势或辅助说明。前端实现应保持紧凑、易扫描。

**变量映射**：

| 部位 | 背景 | 文字 |
| --- | --- | --- |
| 容器 | transparent 或 `color/surface/white` | - |
| 主值 | - | `color/text/gray-950` |
| 说明 / 单位 | - | `color/text/gray-500` |

### 4.13 ChipGroup

ChipGroup 用于展示一组可选择或已选择的标签项。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Mode` | Variant | `Multiple` | `Multiple` |

**使用规则**：当前仅提供 Multiple 模式，适合多选筛选、标签集合和分类标记。若后续需要单选模式，应补充 `Single` 变体。

**变量映射**：

| State | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Default | `color/surface/gray-50` | `color/text/gray-950` | `color/border/gray-200` |
| Selected | `color/brand/primary-bg` | `color/brand/primary` | `color/brand/primary-border` |

### 4.14 Spinner

Spinner 用于局部加载、按钮加载或页面片段加载。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Size` | Variant | `sm` | `sm` / `md` / `lg` |

**使用规则**：sm 用于按钮内或小区域；md 用于卡片、列表；lg 用于页面级或模块级加载。颜色建议映射主色或当前文本色。

**变量映射**：

| Size | 图形颜色 | 说明 |
| --- | --- | --- |
| `sm` | `color/brand/primary` | 按钮内或小区域 |
| `md` | `color/brand/primary` | 卡片、列表 |
| `lg` | `color/brand/primary` | 页面级或模块级加载 |

### 4.15 Tabs

Tabs 是标签页容器，用于同级内容切换。该组合组件由 `Tab Item` 构成，并承载下方内容面板。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Active` | Variant | `First` | `First` |

**使用规则**：Tabs 组件负责整体布局和内容面板，Tab Item 负责单个触发器状态。当前仅提供第一项选中示例，前端应支持任意选中项。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 / 指示 |
| --- | --- | --- | --- |
| Tabs 容器 | transparent 或 `color/surface/white` | - | 内容区可用 `color/border/divider` |
| 内容面板 | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |

### 4.16 Tab Item

Tab Item 是 Tabs 中的单个标签触发器。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Selected` |

**状态规则**：Default 使用次级文本色；Hover 使用浅灰背景；Selected 使用主色文字并显示底部 2px 指示线。需要保证键盘导航和 aria-selected。

**变量映射**：

| State | 背景 | 文字 | 指示 |
| --- | --- | --- | --- |
| `Default` | transparent | `color/text/gray-500` | - |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | - |
| `Selected` | transparent | `color/brand/primary` | 底部 2px `color/brand/primary` |

### 4.17 DropdownMenu

DropdownMenu 用于承载临时菜单、更多操作、上下文操作。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Open` | `Open` |

**使用规则**：当前组件展示 Open 态。菜单项应支持 hover、disabled、destructive、快捷键和分隔线等前端状态扩展。

**变量映射**：

| 部位 / State | 背景 | 文字 | 边框 / 分割 |
| --- | --- | --- | --- |
| Menu container | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| Item Default | transparent | `color/text/gray-950` | - |
| Item Hover | `color/surface/gray-50` | `color/text/gray-950` | - |
| Item Destructive | transparent | `color/semantic/destructive` | - |
| Separator | - | - | `color/border/divider` |

### 4.18 Popover

Popover 用于轻量浮层内容，例如筛选面板、信息卡片、快速编辑区域。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Open` | `Open` |

**使用规则**：与 Tooltip 不同，Popover 可承载可交互内容。应支持点击外部关闭、Esc 关闭和焦点管理。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Popover container | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| Description / meta | - | `color/text/gray-500` | - |
| Divider | - | - | `color/border/divider` |

### 4.19 Table

Table 用于结构化数据展示。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Variant` | Variant | `Surface` | `Surface` |

**使用规则**：Surface 变体适合放在页面或卡片内。表头、行 hover、分割线、选中态应统一映射背景、边框和文本 token。

**变量映射**：

| 部位 / State | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Header | `color/surface/gray-25` 或 `color/surface/gray-50` | `color/text/gray-500` | `color/border/divider` |
| Row Default | `color/surface/white` | `color/text/gray-950` | `color/border/divider` |
| Row Hover | `color/surface/gray-50` | `color/text/gray-950` | `color/border/divider` |
| Row Selected | `color/brand/primary-bg` | `color/text/gray-950` | `color/brand/primary-border` |

### 4.20 Avatar

Avatar 用于用户、团队、文件拥有者或成员身份展示。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Type` | Variant | `Single` | `Group` / `Single` |

**使用规则**：Single 用于单个用户；Group 用于多人协作、共享对象或参与者列表。圆角应使用 full，缺省头像应提供 initials 或图标回退。

**变量映射**：

| Type | 背景 | 文字 | 边框 / 圆角 |
| --- | --- | --- | --- |
| `Single` | 图片或 `color/surface/gray-50` | `color/text/gray-950` | `radius/radius-full` |
| `Group` | 图片或 `color/surface/gray-50` | `color/text/gray-950` | 叠放边框建议 `color/surface/white`，圆角 `radius/radius-full` |

### 4.21 Skeleton

Skeleton 用于内容加载前的占位状态。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Property 1` | Variant | `Default` | `Default` |

**使用规则**：适合用于列表、卡片和文本加载占位。前端实现可按场景扩展矩形、圆形、文本行等形态。

**变量映射**：

| State | 背景 | 动画高光 | 圆角 |
| --- | --- | --- | --- |
| `Default` | `color/surface/gray-50` | 可基于 `color/surface/white` | 按占位形态使用 `radius/radius-md` 或 `radius/radius-full` |

### 4.22 Segmented

Segmented 是分段选择容器，用于少量互斥条件切换。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Active` | Variant | `选项1` | `选项1` / `选项2` / `选项3` |

**使用规则**：适合 2-4 个并列选项，不适合承载过长文本。选中项应有清晰背景或主色反馈。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| 容器 | `color/surface/gray-50` | `color/text/gray-500` | `color/border/gray-200` |
| Active option | `color/surface/white` 或 `color/brand/primary-bg` | `color/brand/primary` | 可补充 `color/brand/primary-border` |

### 4.23 Segmented Option

Segmented Option 是分段控件中的单个选项。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Default` | `Default` / `Hover` / `Selected` |

**状态规则**：Default 为普通态；Hover 展示浅色反馈；Selected 表示当前激活项。需要保持高度与宽度稳定，避免切换时布局跳动。

**变量映射**：

| State | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| `Default` | transparent | `color/text/gray-500` | - |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | - |
| `Selected` | `color/surface/white` 或 `color/brand/primary-bg` | `color/brand/primary` | 可补充 `color/brand/primary-border` |

### 4.24 File Item

File Item 是文件列表组件，覆盖小视图、缩略图、常规列表和上传流程。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `View` | Variant | `Small` | `Small` / `Failed` / `Thumbnail` / `Uploaded` / `Uploading` / `Regular` |
| `State` | Variant | `Default` | `Default` / `Hover` |

**使用规则**：Small 适合链接小卡片；Thumbnail 适合有预览图的文件；Regular 适合列表；Uploading 显示进度或加载；Uploaded 显示完成；Failed 显示失败并提供重试。右侧操作区由 `File Item / Right Slot` 承载。

**变量映射**：

| View / State | 背景 | 文字 | 边框 / 状态 |
| --- | --- | --- | --- |
| `Default` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| `Hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/brand/primary-border` |
| `Uploading` | `color/surface/white` | `color/text/gray-950` | 进度 `color/brand/primary` |
| `Uploaded` | `color/status/success-bg` | `color/semantic/success` | `color/status/success-bg` |
| `Failed` | `color/status/destructive-bg` | `color/semantic/destructive` | `color/status/destructive-bg` |
| `Thumbnail` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |

### 4.25 File Item / Right Slot

File Item / Right Slot 是 File Item 的右侧操作插槽组件。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| 无显式属性 | - | - | - |

**使用规则**：用于承载预览、下载、重试、更多等操作。不同文件状态下应显示不同操作组合，避免把状态逻辑写死在 File Item 主组件中。

**变量映射**：

| 操作 | 图标 / 文字 | Hover 背景 | 说明 |
| --- | --- | --- | --- |
| Preview / Download / More | `color/text/gray-500` | `color/surface/gray-50` | 普通操作 |
| Retry | `color/brand/primary` | `color/brand/primary-bg` | 上传失败后的重试操作 |
| Delete | `color/semantic/destructive` | `color/status/destructive-bg` | 删除或移除操作 |

### 4.26 Drawer Header

Drawer Header 是抽屉顶部区域组件。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `Show Meta` | Boolean | `true` | `true` / `false` |
| `Show Badge` | Boolean | `true` | `true` / `false` |
| `Show icon` | Boolean | `true` | `true` / `false` |

**使用规则**：用于展示抽屉标题、元信息、状态徽章和图标。适合详情页抽屉、任务抽屉、文件抽屉等复合信息面板。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 |
| --- | --- | --- | --- |
| Header container | `color/surface/white` | `color/text/gray-950` | `color/border/divider` |
| Meta | - | `color/text/gray-500` | - |
| Badge | 参考 Badge 变量映射 | 参考 Badge 变量映射 | 参考 Badge 变量映射 |

### 4.27 Drawer

Drawer 用于从页面边缘呼出的详情、编辑或辅助流程面板。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| 无显式属性 | - | - | - |

**使用规则**：示例尺寸为 400x600px。应配合遮罩、关闭按钮、焦点管理和滚动容器。适合不中断主页面上下文的局部任务。

**变量映射**：

| 部位 | 背景 | 文字 | 边框 / 遮罩 |
| --- | --- | --- | --- |
| Overlay | `color/overlay/overlay` | - | - |
| Drawer container | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| Description / meta | - | `color/text/gray-500` | - |

### 4.28 Step Indicator Slot

Step Indicator Slot 是步骤项中的状态图标或状态标记插槽。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Completed` | `Pending` / `Completed` / `Cancelled` / `loading` |
| `size` | Variant | `Default` | `Default` / `sm` |

**使用规则**：Completed 显示完成；Pending 显示等待；Cancelled 显示取消；loading 显示处理中。作为 Slot 可以让步骤组件替换不同图标或状态视觉。

**变量映射**：

| State | 背景 | 图标 / 指示 | 说明 |
| --- | --- | --- | --- |
| `Pending` | transparent | `color/border/gray-200` | 未开始 |
| `Completed` | transparent | `color/semantic/success` | 已完成 |
| `loading` | transparent | `color/brand/primary` | 进行中 |
| `Cancelled` | transparent | `color/semantic/destructive` | 已取消或失败 |

### 4.29 Step Item

Step Item 是单个步骤内容组件。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `State` | Variant | `Completed` | `Completed` / `loading` / `Pending` / `Cancelled` |
| `size` | Variant | `Default` | `Default` / `sm` |

**使用规则**：用于展示步骤标题、描述和当前状态。loading 状态用于当前进行中的步骤，Pending 用于未开始，Cancelled 用于终止或失败流程。

**变量映射**：

| State | 背景 | 标题 / 图标 | 描述 |
| --- | --- | --- | --- |
| `Pending` | transparent | `color/text/gray-500` | `color/text/gray-500` |
| `Completed` | transparent | `color/semantic/success` | `color/text/gray-500` |
| `loading` | transparent | `color/brand/primary` | `color/text/gray-500` |
| `Cancelled` | transparent | `color/semantic/destructive` | `color/text/gray-500` |

### 4.30 Steps

Steps 是步骤流程容器。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `size` | Variant | `Default` | `Default` / `sm` / `Cancelled` |
| `Orientation` | Variant | `Vertical` | `Vertical` |

**使用规则**：当前仅提取到 Vertical 方向。适用于实验流程、上传流程、审批流程、任务执行进度。前端实现可按需扩展 Horizontal。

**变量映射**：

| 部位 | 背景 | 文字 / 图标 | 边框 / 连线 |
| --- | --- | --- | --- |
| 容器 | transparent | `color/text/gray-950` | - |
| Completed step | transparent | `color/semantic/success` | 连线可用 `color/semantic/success` |
| Current loading step | transparent | `color/brand/primary` | 连线可用 `color/brand/primary` |
| Pending step | transparent | `color/text/gray-500` | 连线 `color/border/divider` |
| Cancelled step | transparent | `color/semantic/destructive` | 连线 `color/semantic/destructive` |

### 4.31 Collapse Header

Collapse Header 是折叠面板头部组件。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `size` | Variant | `Default` | `Default` / `double` / `sm` |
| `Show icon` | Boolean | `true` | `true` / `false` |
| `Show Badge` | Boolean | `true` | `true` / `false` |

**使用规则**：用于展示折叠项标题、图标、状态徽章和展开控制。double 适合双行信息，sm 适合紧凑列表。

**变量映射**：

| 部位 / State | 背景 | 文字 / 图标 | 边框 |
| --- | --- | --- | --- |
| Default | transparent 或 `color/surface/white` | `color/text/gray-950` | `color/border/divider` |
| Hover | `color/surface/gray-50` | `color/text/gray-950` | `color/border/divider` |
| Expanded | `color/surface/white` | `color/text/gray-950` | `color/brand/primary-border` 或 `color/border/gray-200` |
| Badge | 参考 Badge 变量映射 | 参考 Badge 变量映射 | 参考 Badge 变量映射 |

### 4.32 Collapse

Collapse 是折叠面板容器，用于展示可展开/收起的信息组。

| 属性 | 类型 | 默认值 | 可选值 |
| --- | --- | --- | --- |
| `size` | Variant | `default` | `default` / `double` / `sm` |
| `style` | Variant | `ghost` | `Default` / `border` / `特殊状态` / `ghost` |
| `state` | Variant | `Default` | `Default` / `hover` / `Expand` |

**使用规则**：组件集包含 27 个变体，覆盖尺寸、样式和展开状态。ghost 适合弱容器背景，border 适合明确分组，特殊状态用于需要状态强调的折叠项。

**变量映射**：

| style / state | 背景 | 文字 | 边框 / 指示 |
| --- | --- | --- | --- |
| `ghost / Default` | transparent | `color/text/gray-950` | `color/border/divider` |
| `ghost / hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/border/divider` |
| `ghost / Expand` | `color/surface/white` | `color/text/gray-950` | `color/border/divider` |
| `border / Default` | `color/surface/white` | `color/text/gray-950` | `color/border/gray-200` |
| `border / hover` | `color/surface/gray-50` | `color/text/gray-950` | `color/brand/primary-border` |
| `border / Expand` | `color/surface/white` | `color/text/gray-950` | `color/brand/primary-border` |
| `特殊状态` | `color/brand/primary-bg` 或状态浅背景 | `color/brand/primary` 或语义色 | 根据状态使用 `color/brand/primary-border` / 语义色 |

---
## 5. 图标组件详细规范

所有图标组件尺寸均为 16x16px，适合放入 Button、Input、Select、Sidebar、File Item、DropdownMenu 等组件中。

| 组件 | 尺寸 | 说明 |
| --- | --- | --- |
| `ic-add` | 16x16 | 新增、添加、创建；Button 左图标默认使用该组件 |
| `ic-delete` | 16x16 | 删除、移除、危险操作；通常映射 destructive 语义 |
| `ic-clear` | 16x16 | 清空输入内容；常用于 Input clearable 后置操作 |
| `ic-check` | 16x16 | 确认、完成、选中；可用于 Checkbox、Toast、Alert |
| `ic-minus` | 16x16 | 减少、移除、半选；可用于 Indeterminate 状态 |
| `ic-next` | 16x16 | 下一步、进入、展开右向动作 |
| `ic-down` | 16x16 | 下拉、展开；常用于 Select、Collapse |
| `ic-up` | 16x16 | 收起、向上折叠 |
| `ic-download` | 16x16 | 下载文件；用于 File Item 右侧操作 |
| `ic-preview` | 16x16 | 预览文件或详情 |
| `ic-retry` | 16x16 | 重试失败任务；常用于上传失败文件项 |
| `ic-more` | 16x16 | 更多操作；用于菜单触发或行操作 |
| `ic-info` | 16x16 | 信息说明、提示、帮助入口 |

---

## 6. 组件清单

| 分类 | 组件 |
| --- | --- |
| 按钮与标签 | `Button`、`Badge`、`Segmented`、`Segmented Option` |
| 表单 | `Input`、`Textarea`、`Select`、`Radio`、`Checkbox`、`Switch`、`Slider`、`Label`、`Label/Form` |
| 反馈 | `Alert`、`Toast`、`Progress`、`Spinner`、`Skeleton`、`Empty`、`Tooltip` |
| 数据展示 | `Card`、`Table`、`Avatar`、`MetricLabel / default`、`ChipGroup` |
| 导航 | `Tabs`、`Tab Item`、`Pagination`、`Sidebar`、`Sidebar Item`、`Sidebar Group` |
| 覆盖层 | `Dialog`、`Drawer`、`Drawer Header`、`DropdownMenu`、`Popover` |
| 复合业务组件 | `File Item`、`File Item / Right Slot`、`Radio Card`、`Checkbox Card`、`Steps`、`Step Item`、`Step Indicator Slot`、`Collapse`、`Collapse Header` |
| 图标 | `ic-add`、`ic-delete`、`ic-clear`、`ic-check`、`ic-minus`、`ic-next`、`ic-down`、`ic-up`、`ic-download`、`ic-preview`、`ic-retry`、`ic-more`、`ic-info` |

---

## 7. 前端实现映射建议

### 7.1 Token 示例

```ts
export const venusDesignToken = {
  color: {
    primary: "#3572FF",
    primaryHover: "#5990FF",
    primaryActive: "#2150D2",
    primaryBg: "#F5F9FF",
    primaryBorder: "#A0C6FF",
    text: "#242428",
    textSecondary: "#8A8A97",
    textInverse: "#FFFFFF",
    bgContainer: "#FFFFFF",
    bgSubtle: "#FAFAFB",
    bgMuted: "#F6F6F7",
    border: "#E8E8EC",
    divider: "rgb(232 232 236 / 50%)",
    ring: "rgb(53 114 255 / 36%)",
    destructive: "#E7000B",
    destructiveRing: "rgb(231 0 11 / 20%)",
    success: "#12B76A",
    warning: "#F59E0B",
    overlay: "rgb(0 0 0 / 50%)",
  },
  radius: {
    xs: 4,
    md: 8,
    lg: 12,
    xl: 16,
    "2xl": 24,
    full: 9999,
  },
  spacing: {
    1: 4,
    2: 6,
    3: 8,
    4: 12,
    5: 16,
    6: 20,
    7: 24,
    8: 32,
    9: 48,
  },
  fontSize: {
    1: 12,
    2: 14,
    3: 16,
    4: 20,
    5: 24,
    6: 28,
    7: 40,
  },
} as const;
```

### 7.2 实现约束

| 约束 | 说明 |
| --- | --- |
| 优先引用 `Frontend Tokens` | 避免在业务页面和组件里散落硬编码色值 |
| Focus 态统一使用 ring token | `color/state/ring` 是默认焦点环来源 |
| Error 态统一使用 destructive token | 边框、文字和 ring 分别映射错误语义 |
| 组件状态需要前端补足可访问性 | Figma 中部分组件未展示 Focus，但实现必须支持键盘焦点 |
| 复合组件内容通过 Slot 扩展 | 避免为每类业务内容复制组件 |
| 图标保持 16x16 基准 | 在按钮、输入、菜单、文件项中保持一致对齐 |
| 当前仅有 Light mode | 暗色模式需要后续补充 Dark mode 变量 |

---

## 8. SFlow 原型落地记录（2026-11-05）

这份记录把 MatwingsVenus DS 作为 SFlow 前端原型的视觉基线。原始规范来自用户提供的文件 `MatwingsVenus-DS-组件详细规范(1).md`；本节是 SFlow 原型的应用约束，不改变原设计规范。

- 原型页面：`docs/prototypes/binder-workspace/index.html`
- 运行方式：在仓库根目录执行 `python3 -m http.server 4173`，然后打开 `http://localhost:4173/docs/prototypes/binder-workspace/`
- 变体切换：`?variant=a`（Canvas first）、`?variant=b`（Run room）、`?variant=c`（Workbench）
- 三个变体都使用同一份内存中的示例 Workflow / Run / File Reference 状态；页面刷新不会持久化。
- 视觉变量直接映射到本文件第 2 节的品牌色、文本色、背景、边框、圆角、间距和字号。
- 页面使用 Sidebar、Sidebar Item、Tabs、Card、Badge、Button、Input、Select、Radio Card、Checkbox Card、Steps、File Item、MetricLabel 等规范组件语义。
- `Select` 是独立的原生 Web Component，文件位于 `docs/prototypes/binder-workspace/components/venus-select.js`。它负责触发器、打开态面板、分组分隔线、键盘上下选择、Enter/Escape 和 `change` 事件；页面只负责传入选项和消费值。
- Agent 交互作为工作区的常驻右侧面板呈现，文件位于 `docs/prototypes/binder-workspace/components/agent-panel.js`；同一面板可在 `Workflow Agent` 与 `Node Agent` 两个上下文之间切换，建议动作直接进入对话线程。
- Slurm 状态放在顶栏和运行上下文条中：连接状态、当前队列、运行中/等待中的数量、GPU 资源；不把这些状态重复写入多个卡片。
- 底部运行上下文使用 Terminal、Logs、Jobs、Candidates 四个 Tab，Jobs 面板直接显示 Slurm Job ID、Node、状态；它与 Agent 面板并列，便于在对话中查看执行反馈。
- 当前原型继续使用原有字体栈和字号变量，不新增字体文件或改变 MatwingsVenus 的文字层级。
- 工作区采用多列侧栏：应用导航、项目文件、节点库、Workflow 画布、Inspector、Agent。节点库的“插入节点”打开独立选择面板，选择 Node 后将其加入画布并把 Node Manifest 上下文交给 Inspector。
- 这是探索“Binder Workflow 工作区应该长什么样”的抛弃式原型，不是生产组件库。选定方案后应将决定折回真实前端并移除其他变体。
