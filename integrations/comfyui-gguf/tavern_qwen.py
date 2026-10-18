"""Qwen-Image 2.1 GGUF language weights with the unchanged native vision tower."""
import torch
import comfy.sd
import folder_paths
from safetensors import safe_open
from .nodes import CLIPLoaderGGUF, GGUFModelPatcher
from .ops import GGMLOps

class TavernQwen21CLIPLoaderGGUF(CLIPLoaderGGUF):
    TITLE = "Qwen-Image 2.1 GGUF + native vision"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip_name": (cls.get_filename_list(),),
            "vision_name": (folder_paths.get_filename_list("clip"),),
        }}

    def load_patcher(self, clip_paths, clip_type, clip_data):
        clip = comfy.sd.load_text_encoder_state_dicts(
            clip_type=clip_type, state_dicts=clip_data,
            model_options={"custom_operations": GGMLOps, "load_device": torch.device("cpu"), "offload_device": torch.device("cpu"), "initial_device": torch.device("cpu"), "dtype": torch.float32},
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        clip.patcher = GGUFModelPatcher.clone(clip.patcher)
        return clip

    def load_clip(self, clip_name, vision_name):
        clip_path = folder_paths.get_full_path_or_raise("clip", clip_name)
        vision_path = folder_paths.get_full_path_or_raise("clip", vision_name)
        data = self.load_data([clip_path])
        # Qwen3-VL's unmodified vision tower is absent from its language GGUF.
        with safe_open(vision_path, framework="pt", device="cpu") as source:
            for key in source.keys():
                if key.startswith("model.visual."):
                    data[0][key] = source.get_tensor(key).clone()
        if "model.visual.deepstack_merger_list.0.norm.weight" not in data[0]:
            raise ValueError("A complete Qwen3-VL vision tower is required")
        return (self.load_patcher([clip_path, vision_path], comfy.sd.CLIPType.QWEN_IMAGE, data),)
