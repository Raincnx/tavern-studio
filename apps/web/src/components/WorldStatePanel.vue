<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { WorldState, StateValue } from '@tavern/contracts';
import { api } from '../api.ts';
const props=defineProps<{chatId:string; update?:WorldState}>();
const emit=defineEmits<{busy:[value:boolean]}>();
const state=ref<WorldState>();const error=ref('');const loading=ref(false);const editing=ref('');const value=ref('');const saving=ref(false);
const addGroup=ref('world');const addName=ref('');const adding=ref(false);
const groups:Record<string,string>={world:'世界与时间',player:'主人公',characters:'人物',relationships:'关系',inventory:'物品',location:'地点',outfit:'服装',memory:'记忆',custom:'其他'};
const fieldNames:Record<string,string>={time:'时间',weather:'天气',current:'当前地点',main:'主角',player:'主人公',name:'姓名',status:'状态',description:'描述',appearance:'外貌',age:'年龄',gender:'性别',mood:'情绪',summary:'概况',shortSummary:'剧情摘要',friend:'朋友',books:'书籍',quantity:'数量',relationship:'关系'};
let version=0;let timer:ReturnType<typeof setTimeout>|undefined;
function accept(next:WorldState){if(next.chatId!==props.chatId)return;state.value=next;emit('busy',next.syncStatus==='updating');clearTimeout(timer);if(next.syncStatus==='updating')timer=setTimeout(()=>void load(),2500);}
async function load(){const current=++version;const id=props.chatId;try{const result=await api<WorldState>(`/chats/${id}/world-state`);if(current===version&&id===props.chatId)accept(result);}catch(e){if(current===version)error.value=e instanceof Error?e.message:'读取失败';}}
watch(()=>props.chatId,()=>{version++;state.value=undefined;editing.value='';error.value='';emit('busy',false);void load();},{immediate:true});
watch(()=>props.update,next=>{if(next){version++;accept(next);}});
onUnmounted(()=>{version++;clearTimeout(timer);emit('busy',false);});
const rows=computed(()=>{
 const result:{path:string;label:string;value:StateValue;locked:boolean}[]=[];
 function visit(v:StateValue,path:string,label:string){if(v&&typeof v==='object'&&!Array.isArray(v)){for(const [k,c]of Object.entries(v))visit(c,path+'/'+k,label+' · '+(fieldNames[k]??k));}else if(v!==''&&!(Array.isArray(v)&&!v.length))result.push({path,label,value:v,locked:(state.value?.lockedPaths??[]).some(p=>path===p||path.startsWith(p+'/'))});}
 if(state.value)for(const [key,label]of Object.entries(groups)){if(key==='memory'){if(state.value.memory.shortSummary)visit(state.value.memory.shortSummary,'/memory/shortSummary','剧情摘要');}else visit(state.value[key as keyof WorldState] as StateValue,'/'+key,label);}
 return result;
});
function display(v:StateValue){return typeof v==='string'?v:JSON.stringify(v);}
function edit(row:typeof rows.value[number]){editing.value=row.path;value.value=display(row.value);error.value='';}
async function patch(patches:unknown[],unlockPaths:string[]=[]){if(!state.value||saving.value)return;const id=props.chatId;saving.value=true;error.value='';try{const result=await api<{state:WorldState}>(`/chats/${id}/world-state/patch`,'POST',{expectedRevision:state.value.revision,patch:patches,unlockPaths});if(id===props.chatId){accept(result.state);editing.value='';adding.value=false;value.value='';}}catch(e){if(id===props.chatId){error.value=e instanceof Error?e.message:'保存失败';await load();}}finally{saving.value=false;}}
async function save(row:typeof rows.value[number]){let next:StateValue=value.value;try{if(typeof row.value!=='string')next=JSON.parse(value.value);}catch{error.value='请保持原来的数字、布尔或数组格式。';return;}await patch([{op:'set',path:row.path,value:next}]);}
async function refresh(){loading.value=true;error.value='';const id=props.chatId;try{await api(`/chats/${id}/world-state/refresh`,'POST',{});if(id===props.chatId)await load();}catch(e){if(id===props.chatId)error.value=e instanceof Error?e.message:'整理失败';}finally{loading.value=false;}}
async function add(){if(!addName.value.trim()||/[\/~]/.test(addName.value)||['__proto__','constructor','prototype'].includes(addName.value)){error.value='请填写普通字段名称，不包含斜线。';return;}await patch([{op:'set',path:`/${addGroup.value}/${addName.value.trim()}`,value:value.value}]);}
</script>
<template>
 <details class="world-panel">
  <summary><span>世界状态</span><small>{{state?.syncStatus==='updating'?'正在整理剧情…':state?.syncStatus==='failed'?'待重试':rows.length?`${rows.length} 项已记录`:'尚未整理'}}</small><span class="world-expand">展开 / 收起</span></summary>
  <div class="world-panel-body">
   <p class="world-help">回复完成后自动整理，下一轮聊天会参考这些事实。手动修改会锁定字段；解锁后允许剧情自动更新。每轮整理会额外调用一次当前文本模型。</p>
   <p v-if="state?.coverage" class="world-help">{{state.coverage}}</p>
   <p v-if="state?.syncError" class="world-error" role="status">{{state.syncError}}</p>
   <p v-if="error" class="world-error" role="alert">{{error}}</p>
   <div class="world-toolbar"><button class="button secondary small" :disabled="loading||saving||state?.syncStatus==='updating'" @click="refresh">{{state?.syncStatus==='failed'?'重试整理':'整理当前剧情'}}</button><button class="text-button" :disabled="saving||state?.syncStatus==='updating'" @click="adding=!adding;editing='';value=''">补充事实</button></div>
   <div v-if="adding" class="world-edit"><label>分类<select v-model="addGroup"><option v-for="(label,key) in groups" :key="key" :value="key" :disabled="key==='memory'">{{label}}</option></select></label><label>名称<input v-model="addName" maxlength="60" placeholder="例如：天气" /></label><label>事实<textarea v-model="value" rows="2" maxlength="2000" /></label><button class="button primary small" :disabled="saving||!value.trim()" @click="add">保存并锁定</button><button class="text-button" @click="adding=false">取消</button></div>
   <p v-if="!rows.length" class="world-help">继续聊天即可逐步建立状态。已有故事可以点击“整理当前剧情”，先读取最近的剧情。</p>
   <div class="world-facts"><article v-for="row in rows" :key="row.path" class="world-fact"><header><strong>{{row.label}}</strong><small v-if="row.locked">已锁定</small></header><template v-if="editing===row.path"><textarea v-model="value" rows="3" maxlength="8000" :aria-label="`修改${row.label}`" /><button class="text-button" :disabled="saving" @click="save(row)">保存并锁定</button><button class="text-button" :disabled="saving" @click="editing=''">取消</button></template><template v-else><p>{{display(row.value)}}</p><footer><button class="text-button" :disabled="saving||state?.syncStatus==='updating'" @click="edit(row)">修正</button><button v-if="row.locked" class="text-button" :disabled="saving||state?.syncStatus==='updating'" @click="patch([],(state?.lockedPaths??[]).filter(p=>row.path===p||row.path.startsWith(p+'/')))">解锁</button></footer></template></article></div>
  </div>
 </details>
</template>
