'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// JSON is a YAML subset accepted by Compose, so the unit gate needs no
// Docker daemon, CLI plugin, YAML parser or additional dependency.
test('managed topology has no local DB dependency and never auto-creates the NAS bind',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../docker-compose.managed.yml'),'utf8'));
  assert.deepEqual(Object.keys(config.services).sort(),['eventouch','web']);
  const api=config.services.eventouch;
  assert.equal(api.depends_on?.db,undefined);assert.equal(api.ports,undefined);
  assert.equal(api.environment.DATABASE_SSL_MODE,'verify-full');
  assert.equal(api.environment.DATABASE_SCHEMA,'${DATABASE_SCHEMA:-eventouch}');
  assert.equal(api.environment.EVENTOUCH_STORAGE_MODE,'mounted');
  assert.match(api.environment.DATABASE_URL,/DATABASE_URL:\?/);
  const nas=api.volumes.find(volume=>volume.target==='/data/storage');
  assert.equal(nas.type,'bind');assert.equal(nas.bind.create_host_path,false);
  assert.equal(api.volumes.find(volume=>volume.target==='/run/secrets/database-ca.pem').read_only,true);
  assert.equal(config.services.web.depends_on.eventouch.condition,'service_healthy');
  assert.equal(config.services.web.build.args.EVENTOUCH_API_URL,'http://eventouch:8776');
});
