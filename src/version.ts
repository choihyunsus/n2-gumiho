// Package metadata is shared by CLI reporting and durable engine replay identity.
export const VERSION: string = (require('../package.json') as { version: string }).version;
