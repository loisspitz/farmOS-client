/* eslint-disable no-undef */
import fromEntries from 'object.fromentries';
import {
  setLogTypes,
  createLog,
  formatLogForServer,
  mergeLogFromServer,
  serializeLog,
  deserializeLog,
  getLastChange,
  getLastSync,
  getConflicts,
  resolveConflict,
} from './farmLog2';

// Shim fromEntries for testing b/c it's not supported in Node.
if (!Object.fromEntries) {
  fromEntries.shim();
}

describe('createLog', () => {
  it('throws if no localID is provided', () => {
    expect(createLog).toThrow();
  });
  it.only('creates new log w/o initial props', () => {
    const log = createLog({ localID: 1 });
    setTimeout(() => {
      log.name = 'I\'m a log!!';
      console.log(getLastChange(log, 'name'));
      log.type = 'farm_observation';
      console.log(log.type);
      console.log(serializeLog(log));
    }, 2000);
  });
});
