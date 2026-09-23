import sharp from 'sharp';
import type { CropRegion } from '../shared';
export async function cropPhoto(filename: string, region: CropRegion): Promise<Buffer> {
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw new Error('截图区域无效');
  const { data, info } = await sharp(filename, { limitInputPixels: 60_000_000 }).rotate().raw().toBuffer({ resolveWithObject: true });
  const left = Math.floor(region.x), top = Math.floor(region.y);
  const right = Math.min(info.width, Math.ceil(region.x + region.width)), bottom = Math.min(info.height, Math.ceil(region.y + region.height));
  if (left >= info.width || top >= info.height || region.x + region.width > info.width + 1 || region.y + region.height > info.height + 1) throw new Error('截图超出照片范围');
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}
