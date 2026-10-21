# Tavern Studio WorldState 世界状态引擎设计

## 目标

在 Tavern Studio 中实现一套服务端拥有、可回滚、可审计的世界状态引擎，覆盖角色扮演状态栏、动态属性、NPC 登记、长期记忆、状态回滚、聊天注入和生图同步。

本设计吸收 SillyTavern statspanel 的能力，但不直接移植其浏览器插件。Tavern Studio 的状态由服务端和 SQLite 管理，前端只通过 API 和事件订阅访问。

## 设计原则

- 每个聊天拥有独立状态，角色资料只提供初始值。
- 模型只能提交受限状态补丁，不能直接覆盖状态树。
- 用户手动确认的事实优先级最高，模型推测不能覆盖。
- 每次生成前创建状态快照，生成失败不污染状态。
- Swipe、重新生成和删除消息必须能够回滚状态。
- 生图读取视觉状态投影，不读取全部内部记忆。
- 状态更新失败不影响聊天文本保存。
- 私密状态、密钥和原始聊天不进入普通日志。
- 旧聊天、完整预设和现有场景状态保持兼容。

## 系统结构

```text
聊天请求
  ↓
WorldStateContextBuilder
  ├── 当前角色与用户身份
  ├── 当前 WorldState 摘要
  ├── 长期记忆检索结果
  ├── 当前 SceneState
  └── 聊天预设
  ↓
文本模型
  ├── 剧情回复
  └── state_patch
  ↓
WorldStateValidator
  ↓
WorldStateEventStore
  ├── 当前状态
  ├── 补丁事件
  ├── 逆向补丁
  └── 生成前快照
  ↓
SSE 事件
  ├── WorldStatePanel
  ├── 聊天界面
  └── 生图状态投影
```

## 数据模型

### WorldState

```ts
interface WorldState {
  chatId: string;
  revision: number;
  worldType: WorldType;
  world: Record<string, StateValue>;
  player: Record<string, StateValue>;
  characters: Record<string, CharacterState>;
  relationships: Record<string, StateValue>;
  inventory: Record<string, StateValue>;
  location: Record<string, StateValue>;
  outfit: Record<string, StateValue>;
  memory: MemoryState;
  custom: Record<string, StateValue>;
  updatedAt: string;
}
```

`StateValue` 支持字符串、数字、布尔值、数组和受限对象。状态树不允许保存密钥、访问令牌、任意脚本或超大文本。

### 状态事件

```ts
interface WorldStateEvent {
  id: string;
  chatId: string;
  messageId?: string;
  revision: number;
  patch: StatePatch[];
  inversePatch: StatePatch[];
  source: 'model' | 'manual' | 'rollback' | 'migration';
  status: 'applied' | 'rejected' | 'partial';
  createdAt: string;
}
```

事件只追加，不原地覆盖历史。当前状态是按事件更新得到的快照。

### 记忆

```ts
interface MemoryState {
  shortSummary: string;
  storySummaries: StorySummary[];
  permanentFacts: MemoryFact[];
  unresolved: string[];
  hiddenCount: number;
}
```

每条长期事实记录来源消息、可信度、是否用户确认和可撤销状态。

## 状态补丁协议

```json
{
  "state_patch": [
    {
      "op": "set",
      "path": "/characters/shen_zhiwei/outfit",
      "value": "暖棕色针织衫"
    },
    {
      "op": "inc",
      "path": "/relationships/user_shen_zhiwei/affection",
      "value": 2
    },
    {
      "op": "add",
      "path": "/inventory",
      "key": "旧书",
      "value": 1
    },
    {
      "op": "del",
      "path": "/world/events/暴雨"
    }
  ]
}
```

第一版支持 `set`、`inc`、`add`、`del`、`merge`、`append`。服务端拒绝任意路径、未知角色、越界数值、错误类型、重复应用和跨聊天引用。

请求必须携带 `expectedRevision`。版本不一致时返回冲突，客户端重新读取状态后再提交，避免并发覆盖。

## 生成管线

### 生成前

`WorldStateContextBuilder` 根据上下文预算生成状态摘要，按以下优先级保留内容：

1. 用户手动确认事实
2. 当前人物、地点、时间和服装
3. 未解决剧情目标
4. 最近变化
5. 长期摘要
6. 可选模块字段

完整状态不直接注入模型。摘要必须有最大字节预算，防止长期剧情挤压正常对话。

### 生成后

模型可以返回结构化对象：

```json
{
  "reply": "剧情文本",
  "state_patch": []
}
```

不支持结构化输出的模型使用受限 fenced JSON 块。服务端先保存剧情文本，再独立解析和校验状态补丁。

状态块解析失败时：

- 剧情文本保存成功。
- 状态事件记为 `rejected`。
- 向前端发布校验失败事件。
- 不自动重试，避免重复生成。

## API

```http
GET  /api/v1/chats/:chatId/world-state
POST /api/v1/chats/:chatId/world-state/patch
PATCH /api/v1/chats/:chatId/world-state
GET  /api/v1/chats/:chatId/world-state/events
POST /api/v1/chats/:chatId/world-state/rollback
POST /api/v1/chats/:chatId/world-state/summarize
GET  /api/v1/chats/:chatId/world-state/memory
```

### 提交补丁

```json
{
  "expectedRevision": 18,
  "sourceMessageId": "message-id",
  "source": "manual",
  "patch": []
}
```

### 返回值

```json
{
  "revision": 19,
  "applied": true,
  "state": {},
  "eventId": "event-id"
}
```

## 回滚

### 普通生成

生成前记录 `before` 快照。状态补丁成功后记录对应逆向补丁。

### Swipe / 重新生成

恢复到目标消息之前的快照，删除该消息之后属于旧分支的状态事件，再应用新回复的补丁。

### 删除消息

恢复最近快照，并按剩余消息顺序重放有效事件。无法重放的事件标记为 `rejected`，不静默猜测。

### 手动修改

手动修改成为最高优先级事实。模型后续只能在明确新剧情有来源消息时覆盖，并保留覆盖关系。

## 模块系统

第一版模块分组：

- 核心：世界、时间、地点、天气
- 玩家：身份、状态、背包、货币
- 角色：NPC 列表、角色状态、关系、服装、装备
- 剧情：世界事件、阵营、声望、任务、剧情进度
- 记忆：摘要、永久事实、未解决事项、隐藏记忆
- 高级：自定义字段、自定义模块、状态历史

每个模块包含字段定义、类型、范围、默认值、提示词说明和是否启用。成人或私密字段默认关闭，并且必须在设置中显式开启。

## NPC 自动注册

模型首次提及新 NPC 时可以提交：

```json
{
  "op": "register_character",
  "id": "npc_li_ming",
  "name": "李明",
  "fields": {
    "relationship": "陌生",
    "mood": "平静"
  }
}
```

服务端生成稳定 ID，限制名称和字段长度，禁止模型创建系统角色或覆盖主角色身份。注册后通过 `world_state.updated` 推送到面板。

## 生图投影

WorldState 不直接作为完整生图提示词。新增投影层：

```text
WorldState
  ↓
VisualStateProjector
  ↓
SceneState
  ↓
compileVisualPrompt
```

视觉投影只保留：

- 入镜人物
- 身份与自然比例
- 当前服装和穿着状态
- 动作、表情和姿势
- 地点、时间、光线
- 人物位置、接触和遮挡
- 当前道具

背包、好感度、隐藏记忆和未公开秘密不进入生图提示词。

## 前端面板

新增 `WorldStatePanel.vue`，分为：

1. 总览：时间、地点、天气、当前人物、剧情目标。
2. 人物：玩家、主角色和 NPC 的状态。
3. 世界：地点、事件、阵营、货币。
4. 记忆：摘要、永久事实、未解决事项。
5. 历史：变更来源、消息链接、回滚和撤销。

默认只显示摘要。字段详情、模块开关和高级编辑放入折叠区域，避免普通用户面对复杂表单。

## 数据迁移

### 现有 Tavern 数据

- 角色资料作为初始角色状态。
- 用户人设作为 player 初始状态。
- 现有 `scene_states` 转为视觉投影快照。
- 现有完整聊天预设保持原 JSON，不写回 WorldState。
- 旧聊天第一次打开时懒加载 WorldState 初始快照。

### 外部 statspanel 数据

提供导入器，将状态映射到 Tavern 字段：

- `player.*` → `player`
- `npc_*.*` → `characters`
- `world.*` → `world`
- `inventory.*` → `inventory`
- 其余字段 → `custom`

未知字段保留在 `custom`，不执行外部脚本，不执行插件命令，不读取 SillyTavern 的任意运行时对象。

导入前自动备份 SQLite 和导入文件；导入失败整体回滚。

## 实施阶段

### 阶段 1：核心状态引擎

- contracts 类型
- SQLite 表
- 补丁应用器
- 路径和类型校验
- 事件和快照
- 单元测试

### 阶段 2：聊天管线

- 生成前状态摘要
- 生成后状态补丁
- revision 冲突处理
- 失败隔离
- 回滚测试

### 阶段 3：面板和手动编辑

- 总览、人物、世界、记忆、历史
- 模块开关
- 手动补丁
- SSE 实时同步

### 阶段 4：长期记忆

- 自动摘要
- 永久事实
- 隐藏记忆
- 记忆检索和手动确认

### 阶段 5：生图整合

- WorldState 到 SceneState 投影
- 多人同框同步
- 服装、动作、关系和地点变化同步
- 参考图身份绑定保持独立

### 阶段 6：外部状态导入

- statspanel JSON 导入
- 字段映射预览
- 导入备份和回滚
- 兼容性报告

## 验收标准

- 同一个聊天的状态不会泄露到其他聊天。
- 状态补丁重复提交不会重复增加数值。
- revision 冲突不会覆盖新状态。
- 模型输出非法补丁时，聊天文本仍然保存。
- 删除消息、Swipe、重新生成都能恢复正确状态。
- 生图能读取当前服装、动作、人数和人物关系。
- 手动确认事实不会被模型猜测覆盖。
- 状态摘要受上下文预算限制。
- 重启服务后状态、事件和记忆完整恢复。
- 导入外部状态失败不会破坏原聊天。
- 不发送真实聊天、密钥或私有预设到外部服务进行测试。

## 风险

- 状态字段过多会挤压聊天上下文，需要摘要和模块预算。
- 模型可能输出看似合法但剧情错误的补丁，需要来源和置信度。
- 长期记忆摘要可能丢失细节，必须支持人工确认和撤销。
- 多人同框状态需要明确人物 ID，不能用角色名模糊匹配。
- 迁移外部状态时必须拒绝脚本、函数和未知命令。

## 第一批实现范围

第一批只实现核心状态引擎、事件、快照、补丁校验和聊天注入，不一次性打开全部高级字段。完成基础回滚和稳定性测试后，再逐步启用 NPC、长期记忆和高级模块。
