// Track the installed release and the durable workflow record contract independently.
export const VERSION: string = (require('../package.json') as { version: string }).version;
export const REPLAY_VERSION = '1.0.0';
