# GPU 分阶段优化（2026-10-18）

新建任务使用 Q8_0 GGUF 文本权重、原生 Qwen3-VL vision tower 与原标准版 INT8 生图主模型，仍为 25 步。不是 Turbo 主模型替换。

## 核实与原因

接手时 3000、8188 均未运行，旧日志最后两次任务已完成。恢复原配置后测量固定茶杯参考图，编码节点占主要耗时。历史 GPU 崩溃堆栈经过 `GGMLTensor.to → ModelPatcher.partially_unload`；另有原编码器在模型映射读取时的原生崩溃。这里只规避已知阶段交接中的部分卸载路径，未证明修复所有 access violation。

12GB 显存不能让约 10.9GiB 的编码器和约 6.76GiB 的主模型同时常驻。实测 GPU 编码器仍由 ComfyUI 部分加载，约 1.8–2.7GiB 权重卸载到 CPU，因此不是“全模型强制塞进 GPU”。系统只有约 32GiB 物理内存；不要禁用 mmap 后同时复制整套权重。

## 实现

- `TavernQwen21CLIPLoaderGGUF` 新增可选 `execution_device`，缺省 `cpu`，旧快照行为不变。新工作流显式选择 `cuda`，初始与卸载设备仍是 CPU。
- GPU 模式把非量化浮点权重在内存中转换为 BF16；Q8_0 量化数据与磁盘模型不变。ComfyUI 从 norm 权重检测实际计算 dtype，仅设置 `model_options.dtype` 不足以覆盖 GGUF 中的 F32 norm。
- `TavernQwen21TextEncodeStaged` 继承原生编码节点，保留多参考图接口。编码前完整卸载上一轮模型，编码结束（包括 Python 异常）后通过 `finally` 完整卸载，再交给正常采样。原生崩溃无法靠 `finally` 捕获。
- 后端拒绝 GPU GGUF 搭配普通编码节点。新任务冻结新工作流；旧任务及按原参数重试保留旧快照。
- 初始保留 `--reserve-vram 1.5 --disable-fast-disk --disable-dynamic-vram --disable-async-offload --disable-pinned-memory --cache-classic --offline`。2026-10-19 真实场景内存对照后，仅将 `--cache-classic` 改为 `--cache-none`，同步本机 `Start-QwenImage.ps1`，保留 faulthandler 和其他开关；见[真实场景断连诊断](真实场景断连诊断.md)。

## 实测

本地合成蓝杯参考图，提示词要求浅色亚麻桌布和绿色书，seed=314159，1024×1024，25 步。无真实聊天、私有预设或外部模型调用。

| 配置 | 总耗时 | 编码节点（含阶段卸载） | 采样节点（含加载） | 采样显存峰值 |
| --- | ---: | ---: | ---: | ---: |
| 原 CPU/FP32，加载节点已缓存 | 124.75s | 102.72s | 21.11s | 10175MiB |
| GPU/BF16 原型，冷启动 | 48.65s | 11.64s | 28.78s | 10385MiB |
| GPU/BF16 原型，重新编码 | 32.42s | 9.81s | 21.62s | 10386MiB |
| 正式节点，冷启动参考图 | 51.08s | 14.40s | 28.45s | 10271MiB |
| 正式节点，随后纯文生图 | 19.70s | 6.10s | 12.63s | 10449MiB |
| 正式节点，再次参考图 | 32.15s | 9.50s | 21.63s | 10384MiB |
| 生产 8188 部署验收，冷启动参考图 | 50.47s | 14.24s | 28.13s | 10496MiB |

重复参考图测试添加了一个换行以使编码缓存失效。冷启动与暖缓存总时间不应视为严格同条件比较。计时来自 WebSocket 节点边界，显存为约每秒一次的 nvidia-smi **观测峰值**，不保证捕捉毫秒级峰值。首轮原型还记录编码阶段 PyTorch allocated 峰值 8601MiB、reserved 峰值 8992MiB，二者与整卡显存口径不同。

CPU 与 GPU 输出均保留蓝杯并生成浅色桌布、绿书；GPU/BF16 下书的位置有变化，不承诺逐像素一致。短期多轮通过不等于长时间、任意分辨率或多张参考图全部稳定。尚未用用户真实剧情验收。旧任务的 522.91s/513.45s 与本次固定场景不同，不能拿来直接计算加速比。

原始测量保存在本地 `temp/gpu-benchmark-*.json`，不包含私人内容；测试图在 ComfyUI 的 `output/TavernBenchmark/` 与隔离服务 `temp/gpu-lab/output/TavernBenchmark/`。可用 `integrations/comfyui-gguf/benchmark.mjs` 复测，说明见同目录 README。测试不创建 Tavern 角色、聊天或图片任务记录。

## 验证与回退

最终 TypeScript 类型检查、前端构建通过；全量 57 项服务端测试通过，包括 GPU 节点配对、旧 CPU 快照与多参考图编译兼容性。隔离试验使用 8189，部署前已确认所有生成空闲并关闭隔离服务。

重启后角色 3、聊天 4、历史图片任务 43；设置摘要和完整预设文件 SHA-256 与部署前一致，密钥存在。未提交或推送 Git 改动。

生产验收成功，Tavern 的 ComfyUI 连接与节点校验通过，8188 队列归零；3000 和 8188 在线，8189 隔离服务已关闭。生产扩展与项目副本 SHA-256 一致。当前 ComfyUI 日志为 `QwenImage21/logs/gpu-staged.stdout.log`、`gpu-staged.stderr.log`。

若出现崩溃或效果回退，等待所有生图与聊天生成空闲，把 `workflows/qwen-image-2.1-gguf-cpu.json` 复制到 `workflows/qwen-image-2.1-standard-v1.json` 后重启 Tavern。新任务回到 CPU；已冻结的 GPU 任务重试仍使用 GPU，应新建任务。必要时在队列空闲后重启 ComfyUI。

部署前本机扩展和启动脚本备份在 `QwenImage21/logs/gpu-rollout-backup-20261018/`。无需删数据库、聊天、模型或密钥。
