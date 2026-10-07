(function(E){'use strict';
E.boothStampSummary=(booths,visits,participantId)=>{
 const ids=new Set((Array.isArray(booths)?booths:[]).filter(b=>b&&typeof b.id==='string'&&b.id).map(b=>b.id));
 const own=typeof participantId==='string'&&participantId.length>0;
 const visited=new Set((Array.isArray(visits)?visits:[]).filter(v=>own&&v&&v.participantId===participantId&&ids.has(v.boothId)).map(v=>v.boothId));
 const visitedBoothIds=[...ids].filter(id=>visited.has(id));
 return {total:ids.size,completed:own?visitedBoothIds.length:null,visitedBoothIds};
};
for(const name of ['booth.map.save','booth.map.publish','booth.map.unpublish'])
 E.register(name,'booth',()=>{throw Error('배치도 변경은 서버에 연결된 운영자 화면에서만 할 수 있습니다.');});
})(window.ET);
