// Connection settings for the lab. On the host every service is reached on
// 127.0.0.1 via the published ports; inside compose (LAB_IN_CONTAINER=1) the
// service hostnames and container ports are used instead.
const env = process.env;
const inContainer = env.LAB_IN_CONTAINER === '1';

const mongoHost = inContainer ? 'mongo' : 'localhost';
const oraHost = inContainer ? 'oracle' : 'localhost';
const port = (hostPort, containerPort) => (inContainer ? containerPort : hostPort);

const migPassword = env.MIG_PASSWORD || 'MigUser2026';

export const config = {
  mongoSrcUri:
    `mongodb://${mongoHost}:${port(27117, 27017)}/telco?replicaSet=rs0&directConnection=true`,
  oraMongoUri:
    `mongodb://MIG:${encodeURIComponent(migPassword)}@${oraHost}:${port(27119, 27017)}/MIG` +
      '?authMechanism=PLAIN&authSource=$external&tls=false&retryWrites=false&loadBalanced=true',
  // For the MongoDB Database Tools and mongosh. They run in a container (the
  // runner, or lab-mongo through `./lab.sh exec`), so they always use the
  // compose service names. No database in the path: mongorestore reads a path
  // as --db and then restores 0 documents without an error (Ruling Q).
  toolSrcUri: 'mongodb://mongo:27017/?replicaSet=rs0&directConnection=true',
  toolOraUri:
    `mongodb://MIG:${encodeURIComponent(migPassword)}@oracle:27017/` +
      '?authMechanism=PLAIN&authSource=$external&tls=false&retryWrites=false&loadBalanced=true',
  oraSql: {
    user: 'MIG',
    password: migPassword,
    connectString: `${oraHost}:${port(1523, 1521)}/FREEPDB1`,
  },
  // The order service (app): host port 3300, or the app service in compose.
  appUrl: env.LAB_APP_URL || (inContainer ? 'http://app:3300' : 'http://127.0.0.1:3300'),
  consolePort: Number(env.CONSOLE_PORT || 3200),
  seed: Number(env.SEED || 20261114),
};
