import { crc32, inflateSync } from 'node:zlib';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.ts';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function inspectPng(buffer: Buffer): { clean: Buffer; width: number; height: number; card?: unknown } {
  if (buffer.length > 24 * 1024 * 1024 || !buffer.subarray(0, 8).equals(signature)) throw new AppError(400, 'INVALID_IMAGE', '只支持不超过 24MB 的 PNG 图片');
  const retained: Buffer[] = [signature];
  const compressed: Buffer[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let rowBytes = 0;
  let ended = false;
  let count = 0;
  let card: unknown;
  while (offset + 12 <= buffer.length) {
    if (++count > 2048) throw new AppError(400, 'INVALID_IMAGE', '图片块数量超过限制');
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > buffer.length) throw new AppError(400, 'INVALID_IMAGE', 'PNG 数据不完整');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw new AppError(400, 'INVALID_IMAGE', 'PNG 校验失败');
    if (count === 1 && type !== 'IHDR') throw new AppError(400, 'INVALID_IMAGE', '缺少 PNG 头');
    if (type === 'IHDR') {
      if (count !== 1 || length !== 13) throw new AppError(400, 'INVALID_IMAGE', 'PNG 头格式错误');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
      const depths = colorType === 3 ? [1, 2, 4, 8] : colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
      if (!width || !height || width > 4096 || height > 4096 || !channels || !depths.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new AppError(400, 'INVALID_IMAGE', '图片尺寸或编码不支持（暂不支持交错 PNG）');
      rowBytes = Math.ceil(width * channels * bitDepth / 8) + 1;
    }
    if (type === 'IDAT') compressed.push(data);
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) retained.push(buffer.subarray(offset, end));
    else if ((type.charCodeAt(0) & 32) === 0) throw new AppError(400, 'INVALID_IMAGE', '图片包含不支持的关键数据块');
    if (type === 'tEXt' && data.length < 3 * 1024 * 1024) {
      const separator = data.indexOf(0);
      if (separator > 0 && ['chara', 'ccv3'].includes(data.toString('ascii', 0, separator))) {
        try { card = JSON.parse(Buffer.from(data.subarray(separator + 1).toString('ascii'), 'base64').toString('utf8')); }
        catch { throw new AppError(400, 'INVALID_CARD', '角色卡元数据无法解析'); }
      }
    }
    offset = end;
    if (type === 'IEND') { if (length !== 0) throw new AppError(400, 'INVALID_IMAGE', 'PNG 结束块错误'); ended = true; break; }
  }
  if (!ended || offset !== buffer.length || !compressed.length) throw new AppError(400, 'INVALID_IMAGE', '图片内容不完整或有额外数据');
  try {
    const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * height + 1 });
    if (decoded.length !== rowBytes * height) throw new Error('length');
    for (let row = 0; row < height; row++) if (decoded[row * rowBytes] > 4) throw new Error('filter');
  } catch { throw new AppError(400, 'INVALID_IMAGE', 'PNG 像素数据校验失败'); }
  return { clean: Buffer.concat(retained), width, height, card };
}

export async function savePng(directory: string, id: string, data: Buffer): Promise<ReturnType<typeof inspectPng>> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('资源标识不合法');
  const image = inspectPng(data);
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  const temporary = join(media, `${id}.tmp`);
  await writeFile(temporary, image.clean, { flag: 'w' });
  await rename(temporary, join(media, `${id}.png`));
  return image;
}

export async function limitedBuffer(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maximum || !response.body) throw new AppError(502, 'RESPONSE_TOO_LARGE', '服务返回内容超过限制或为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) throw new AppError(502, 'RESPONSE_TOO_LARGE', '服务返回内容超过限制');
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
