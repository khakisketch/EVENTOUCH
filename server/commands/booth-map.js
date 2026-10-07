'use strict';
const COMMANDS = new Set(['booth.map.save','booth.map.publish','booth.map.unpublish']);
function expected(ctx,value) {
  if (!Number.isSafeInteger(value) || value < 0) throw ctx.fail(400,'지도 버전을 확인하세요');
  return value;
}
function points(ctx,value) {
  if (!Array.isArray(value) || value.length > ctx.workspace.booths.length) throw ctx.fail(400,'부스 위치를 확인하세요');
  const boothIds = new Set(ctx.workspace.booths.map(b => b && b.id));
  const seen = new Set();
  return value.map(p => {
    if (!p || typeof p.boothId !== 'string' || !boothIds.has(p.boothId) || seen.has(p.boothId) ||
        typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
        p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) throw ctx.fail(400,'부스 위치를 확인하세요');
    seen.add(p.boothId); return {boothId:p.boothId,x:p.x,y:p.y};
  });
}
async function image(ctx,fileId) {
  const file = await ctx.resolveFile({fileId},{eventId:ctx.event.id,contentTypes:['image/png','image/jpeg','image/webp'],maxBytes:600000});
  if (!Number.isInteger(file.width) || !Number.isInteger(file.height) || file.width < 1 || file.height < 1 ||
      file.width > 10000 || file.height > 10000) throw ctx.fail(400,'크기가 확인된 배치도 이미지를 업로드하세요');
  return file;
}
async function apply(ctx) {
  if (!ctx.event.features.includes('stamp')) throw ctx.fail(409,'스탬프 기능을 먼저 켜세요');
  const map = ctx.workspace.boothMap;
  const input = ctx.input;
  if (ctx.command === 'booth.map.save') {
    const version = expected(ctx,input.expectedDraftVersion);
    if (version !== (map.draft ? map.draft.version : 0)) throw ctx.fail(409,'다른 운영자가 지도를 수정했습니다. 다시 불러오세요');
    const locations = points(ctx,input.points);
    const file = await image(ctx,input.fileId);
    if (map.draft && map.draft.image.fileId !== file.fileId && locations.length) throw ctx.fail(409,'이미지를 교체할 때 이전 위치를 비우세요');
    map.draft = {version:version+1,image:file,points:locations};
  } else if (ctx.command === 'booth.map.publish') {
    const version = expected(ctx,input.expectedDraftVersion);
    if (!map.draft || version !== map.draft.version) throw ctx.fail(409,'게시할 지도 초안을 다시 확인하세요');
    const file = await image(ctx,map.draft.image.fileId);
    const locations = points(ctx,map.draft.points);
    map.published = {version,image:file,points:locations,publishedAt:ctx.now};
  } else {
    const version = expected(ctx,input.expectedPublishedVersion);
    if (map.published && version !== map.published.version) throw ctx.fail(409,'게시된 지도 버전을 다시 확인하세요');
    map.published = null;
  }
  return {body:{boothMap:structuredClone(map)}};
}
module.exports = {COMMANDS,apply};
