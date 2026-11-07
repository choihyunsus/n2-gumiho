import GumihoModule = require('n2-gumiho');
const factory: typeof GumihoModule.Gumiho.create = GumihoModule.Gumiho.create;
const limits: Partial<GumihoModule.ExecutionLimits> = { localConcurrency: 1, cloudConcurrency: 2 };
const options: GumihoModule.CoordinatorOptions = {
  sourceTail: 'analyze',
  verifyTail: 'verify',
  targets: ['build'],
};
void factory;
void limits;
void options;
