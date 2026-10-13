(function(E){
 'use strict';
 let refreshing=false;
 const refresh=async()=>{
  if(refreshing||E.previewMode||E.storageMode!=='server'||E.route?.scope!=='display'||!E.session||document.visibilityState==='hidden'||typeof E.remote?.bootstrap!=='function')return;
  refreshing=true;
  try{
   await E.remote.bootstrap();
   if(E.route?.scope==='display')E.render?.();
  }catch(error){
   // Keep the last approved screen visible during a brief network interruption.
   if(E.remote?.status==='connected'){
    E.remote.status='stale';
    E.remote.error=error?.message||'';
   }
  }finally{refreshing=false;}
 };
 window.setInterval(refresh,5000);
})(window.ET);
