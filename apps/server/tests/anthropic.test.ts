import test from 'node:test';
import assert from 'node:assert/strict';
import { mockServer } from './helpers.ts';
import { ChatCompletionsAdapter } from '../src/text-adapter.ts';
import type { Settings } from '@tavern/contracts';
test('Anthropic transport maps native JSON and chunked SSE without exposing thinking', async t => {
 const url=await mockServer(t,(req,res,body)=>{
  assert.equal(req.url,'/v1/messages');assert.equal(req.headers['x-api-key'],'test-key');assert.equal(req.headers['anthropic-version'],'2023-06-01');
  assert.deepEqual(body.system,[{type:'text',text:'rules'}]); assert.deepEqual(body.messages,[{role:'user',content:'hello'}]);
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'text',text:'Hello'}],stop_reason:'end_turn'}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const data of [{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}},{type:'content_block_delta',delta:{type:'text_delta',text:'你好'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}]){const bytes=Buffer.from('data: '+JSON.stringify(data)+'\r\n\r\n');res.write(bytes.subarray(0,7));res.write(bytes.subarray(7));}res.end();
 });
 const s={textProtocol:'anthropic',textUrl:url,textModel:'claude-opus-4-6',maxTokens:256} as Settings;const a=new ChatCompletionsAdapter();
 const messages=[{role:'system' as const,content:'rules'},{role:'user' as const,content:'hello'}];
 const j=await(await a.generate(s,'test-key',messages,false,new AbortController().signal)).json();assert.equal(j.choices[0].message.content,'Hello');
 const stream=await(await a.generate(s,'test-key',messages,true,new AbortController().signal)).text();assert.ok(stream.includes('你好'));assert.ok(stream.includes('[DONE]'));assert.ok(!stream.includes('private'));
});

test('Claude stream rejects truncation, provider errors and missing completion', async t => {
 for (const events of [[{type:'message_delta',delta:{stop_reason:'max_tokens'}}],[{type:'error',error:{message:'private upstream detail'}}],[{type:'message_stop'}]]) {
  const url=await mockServer(t,(_req,res)=>res.writeHead(200,{'content-type':'text/event-stream'}).end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')));
  const response=await new ChatCompletionsAdapter().generate({textProtocol:'anthropic',textUrl:url,textModel:'test',maxTokens:256} as Settings,'',[],true,new AbortController().signal);
  await assert.rejects(response.text());
 }
});

test('protocol stays isolated when switching model profiles', async t => {
 const { fixture }=await import('./helpers.ts'); const studio=await fixture(t);const initial=studio.store.settings();
 const created=await studio.call('/text-models','POST',{...initial,textProtocol:'anthropic',textProfileName:'Claude',textUrl:'http://localhost:8080/v1',textModel:'claude-opus-4-6'});
 assert.equal(created.statusCode,200);const profile=created.json<Settings>();assert.equal(profile.textProtocol,'anthropic');
 const back=await studio.call(`/text-models/${initial.activeTextProfileId}/activate`,'POST',{});assert.equal(back.json<Settings>().textProtocol,'openai');
 const again=await studio.call(`/text-models/${profile.activeTextProfileId}/activate`,'POST',{});assert.equal(again.json<Settings>().textProtocol,'anthropic');
});


test('Claude effort reaches native API and structured extraction disables thinking',async t=>{
 const requests:any[]=[];const url=await mockServer(t,(_req,res,body)=>{requests.push(body);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'text',text:'{}'}],stop_reason:'end_turn'}));});
 const adapter=new ChatCompletionsAdapter();
 for(const effort of ['default','minimal','low','medium','high'] as const){
  await adapter.generate({textProtocol:'anthropic',textUrl:url,textModel:'claude-opus-4-6',maxTokens:4096,textReasoningEffort:effort} as Settings,'',[{role:'user',content:'test'}],false,new AbortController().signal);
  const body=requests.at(-1);if(effort==='default')assert.equal(body.thinking,undefined);else {assert.deepEqual(body.thinking,{type:'adaptive'});assert.equal(body.output_config.effort,effort==='minimal'?'low':effort);}
 }
 await adapter.generate({textProtocol:'anthropic',textUrl:url,textModel:'claude-opus-4-6',maxTokens:4096,textReasoningEffort:'high'} as Settings,'',[],false,new AbortController().signal,true);
 assert.deepEqual(requests.at(-1).thinking,{type:'disabled'});assert.equal(requests.at(-1).output_config,undefined);
});
