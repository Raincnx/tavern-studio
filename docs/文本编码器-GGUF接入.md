# Studio 文本编码器接入

当前新建生图任务使用 AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF 的 Q8_0 文本权重。生图主模型仍为原 Qwen-Image 2.1 标准版 INT8，25 步；并未切换 Turbo 主模型。

- 模型仓库版本：df96693dbdfb8738c0bf1bbd0337d149808db948
- 文件：Qwen-Image-2.1-Turbo-Uncensored-Q8_0.gguf
- SHA-256：f8f9f6276b726db5291f4a5343089612cb5fd08aa81e8f0791dc66d2c03d07ca（已核对远端）
- ComfyUI-GGUF 基础版本：6ea2651e7df66d7585f6ffee804b20e92fb38b8a
- 额外依赖：gguf 0.19.0
- 局部节点：ComfyUI/custom_nodes/ComfyUI-GGUF/tavern_qwen.py，注册为 TavernQwen21CLIPLoaderGGUF。
- 视觉部分：沿用原 qwen3vl_8b_int8_convrot.safetensors 中完整的 model.visual 权重，不覆盖新文本权重。不要删除原文件。

当前编码在 CPU 上运行，生图主模型使用 GPU。GPU 编码试验在卸载权重时发生 Windows access violation，故选择此配置；编码耗时会增加。启动参数禁用动态显存、异步卸载、锁页内存与 safetensors mmap。

原工作流备份：workflows/qwen-image-2.1-original-encoder.json。回退时将其复制为 qwen-image-2.1-standard-v1.json 并重启 Studio 后端。已有任务与“按原参数重试”使用存储的工作流快照，只有新建任务采用新编码器。

本地验证记录位于 temp/gguf-text-result.json 和 temp/gguf-reference-validation.json。验证使用茶杯静物，不涉及用户聊天内容。

验证结果：纯文本静物生图成功；参考图任务执行成功，耗时 145.52 秒。但参考图结果明显过锐，未正确遵循更换桌布、添加书本的编辑要求。仅确认技术链路可运行，不代表编辑质量或角色一致性已通过验收。后续需与原编码器同种子对比评估。
