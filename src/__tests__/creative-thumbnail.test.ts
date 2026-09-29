import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { makeImageThumbnail, THUMB_WIDTH } from '../services/creative-thumbnail.service.js';

describe('makeImageThumbnail', () => {
  it('shrinks to the thumbnail width as webp and reports the original size', async () => {
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2a7' } }).png().toBuffer();
    const { thumb, width, height } = await makeImageThumbnail(png);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(THUMB_WIDTH);
    expect(meta.height).toBe(320);
    expect([width, height]).toEqual([1200, 800]);
  });

  it('never enlarges a small image', async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#000' } }).png().toBuffer();
    const meta = await sharp((await makeImageThumbnail(png)).thumb).metadata();
    expect(meta.width).toBe(200);
  });
});
