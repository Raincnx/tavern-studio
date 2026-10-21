# Studio 文本编码器接入

当前新建生图任务使用 AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF 的 Q8_0 文本权重。生图主模型仍为原 Qwen-Image 2.1 标准版 INT8，25 步；并未切换 Turbo 主模型。

- 模型仓库版本：df96693dbdfb8738c0bf1bbd0337d149808db948
- 文件：Qwen-Image-2.1-Turbo-Uncensored-Q8_0.gguf
- SHA-256：f8f9f6276b726db5291f4a5343089612cb5fd08aa81e8f0791dc66d2c03d07ca（已核对远端）
- ComfyUI-GGUF 基础版本：6ea2651e7df66d7585f6ffee804b20e92fb38b8a
- 额外依赖：gguf 0.19.0
- 局部节点：ComfyUI/custom_nodes/ComfyUI-GGUF/tavern_qwen.py，注册为 TavernQwen21CLIPLoaderGGUF。
- 视觉部分：沿用原 qwen3vl_8b_int8_convrot.safetensors 中完整的 model.visual 权重，不覆盖新文本权重。不要删除原文件。

当前新工作流使用 GPU/BF16 编码与显式完整卸载，再由 GPU 采样；12GB 显存下编码器仍有部分权重由 ComfyUI 卸载到 CPU，并非整套模型同时常驻。旧工作流快照缺少 execution_device 时仍使用 CPU/FP32。此前 GPU 试验在部分卸载权重时发生 Windows access violation；本次绕开该阶段交接路径，尚不能视为彻底修复原生崩溃。运行仍禁用动态显存、异步卸载、锁页内存，保留 mmap；禁用 mmap 后曾触及 Windows 提交内存上限。实测、边界与回退见 [GPU 分阶段优化](./GPU分阶段优化.md)。

原工作流备份：workflows/qwen-image-2.1-original-encoder.json。回退时将其复制为 qwen-image-2.1-standard-v1.json 并重启 Studio 后端。已有任务与“按原参数重试”使用存储的工作流快照，只有新建任务采用新编码器。

本地验证记录位于 temp/gguf-text-result.json 和 temp/gguf-reference-validation.json。验证使用茶杯静物，不涉及用户聊天内容。

验证结果：纯文本静物生图成功。最初参考图编辑沿用原图 Seed 42，出现过锐与忽略编辑。原编码器同参数也复现；仅换编辑 Seed 为 314159 后，两种编码器都恢复桌布与书本编辑，当前 GGUF 结果保留杯子特征且无明显过锐。Studio 已增加已知参考图种子冲突检查。详见 [参考图编辑诊断](./参考图编辑诊断.md)。这不等于所有编辑或角色一致性均已通过验收。
