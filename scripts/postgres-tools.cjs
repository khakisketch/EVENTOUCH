'use strict';
const {Client}=require('pg');
const {databaseConnectionOptions}=require('../server/database-config');

// Match the driver's effective endpoint, including URL overrides. Never put
// connection strings or passwords in subprocess arguments or error messages.
function postgresToolEnvironment({connectionString,env=process.env}) {
  const options=databaseConnectionOptions({connectionString,env});
  const parameters=new Client(options).connectionParameters;
  const child=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('PG')));
  Object.assign(child,{
    PGHOST:String(parameters.host),PGPORT:String(parameters.port),
    PGUSER:String(parameters.user),PGDATABASE:String(parameters.database),
    PGPASSWORD:parameters.password || '',PGSSLMODE:options.ssl ? 'verify-full':'disable',
    PGCONNECT_TIMEOUT:'5',PGOPTIONS:options.options || parameters.options || '',
    PGAPPNAME:'eventouch-backup',
  });
  if(options.ssl && (env.DATABASE_SSL_CA_FILE || env.PGSSLROOTCERT)) child.PGSSLROOTCERT=env.DATABASE_SSL_CA_FILE || env.PGSSLROOTCERT;
  return child;
}
module.exports={postgresToolEnvironment};
