/* eslint-disable no-param-reassign */
import { uniq, zipObj, without } from 'ramda';
import defaultResources from '../core/store/defaultResources';

const data = Symbol('data');
const changed = Symbol('changed');
const conflicts = Symbol('conflicts');
const lastSync = Symbol('lastSync');

function createSymbolRegistry(logTypes) {
  const uniqueFields = uniq(Object.values(logTypes)
    .flatMap(({ fields }) => Object.keys(fields)));
  const fieldSymbols = zipObj(
    uniqueFields,
    uniqueFields.map(f => Symbol(f)),
  );
  return {
    name: Symbol('name'),
    timestamp: Symbol('timestamp'),
    done: Symbol('done'),
    ...fieldSymbols,
    // NB: We don't need to register properties that don't change once set,
    // like id, type, and localID.
  };
}

function updateSymbolRegistry(registry, newLogTypes) {
  const uniqueFields = uniq(Object.values(newLogTypes)
    .flatMap(({ fields }) => Object.keys(fields)));
  uniqueFields.forEach((f) => {
    if (!registry[f]) {
      registry[f] = Symbol(f);
    }
  });
}

function makeDefault(schema) {
  if (schema === null) {
    return null;
  }
  if (Array.isArray(schema)) {
    return [];
  }
  if (typeof schema === 'object') {
    const entries = Object.entries(schema)
      .map(([key, val]) => ([key, makeDefault(val)]));
    return Object.fromEntries(entries);
  }
  return schema;
}

function setOnce(obj, key, value) {
  const writable = value === undefined;
  Object.defineProperty(obj, key, {
    value,
    writable,
    configurable: true,
    enumerable: true,
  });
}

function farmLog(_logTypes) {
  let logTypes = _logTypes;
  const symbolRegistry = createSymbolRegistry(logTypes);

  function createProperty(obj, key, val, _changed, _conflicts) {
    const sym = symbolRegistry[key];
    Object.defineProperty(obj, sym, {
      enumerable: false,
      value: {
        [data]: val,
        [changed]: _changed || Math.floor(Date.now() / 1000),
        [conflicts]: _conflicts || [],
      },
    });
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get: function symbolGetter() {
        return this[sym][data];
      },
      set: function symbolSetter(value) {
        this[sym][changed] = Math.floor(Date.now() / 1000);
        this[sym][data] = value;
      },
    });
  }

  // The type determines what other properites are included, so it requires
  // a special setter. Also, it can only be changed before it is synced with the
  // server, so it doesn't need metadata.
  function createTypeProperty(obj, val) {
    Object.defineProperty(obj, 'type', {
      enumerable: true,
      configurable: true,
      get: function typeGetter() {
        return val;
      },
      set: function typeSetter(newType) {
        const oldType = val;
        const oldSchemaKeys = Object.keys(logTypes[oldType].fields);
        const newSchemaKeys = Object.keys(logTypes[newType].fields);
        const keysToBeAdded = without(oldSchemaKeys, newSchemaKeys);
        const keysToBeRemoved = without(newSchemaKeys, oldSchemaKeys);
        keysToBeAdded.forEach((key) => {
          const value = makeDefault(logTypes[newType].fields[key].data_schema);
          createProperty(this, key, value);
        });
        keysToBeRemoved.forEach((key) => {
          const sym = symbolRegistry[key];
          delete this[sym];
          delete this[key];
        });
        val = newType;
      },
    });
  }

  return {
    setLogTypes(newTypes) {
      logTypes = newTypes;
      updateSymbolRegistry(symbolRegistry, newTypes);
    },
    createLog(props = {}, _lastSync = 0) {
      if (!props.localID) {
        throw new Error('A localID must be provided when creating a new log.');
      }

      // Set a common timestamp to be used for the latest change on all properties.
      const _changed = props.changed || Math.floor(Date.now() / 1000);
      const log = {};

      // Set properties for what farmOS considers "properties" (vs "fields").
      createProperty(log, 'name', (props.name || ''), _changed);
      createProperty(log, 'timestamp', (props.timestamp || _changed), _changed);
      createProperty(log, 'done', (props.done || false), _changed);
      // If the log is coming from the server, freeze its type; otherwise, use
      // the special createTypeProperty function.
      const type = props.type || 'farm_activity';
      if (props.id) {
        setOnce(log, 'type', type);
      } else {
        createTypeProperty(log, type);
      }

      // Set properties for "fields".
      const schema = logTypes[type]?.fields;
      Object.entries(schema).forEach(([key, { data_schema: dataSchema }]) => {
        const val = props[key] !== undefined ? props[key] : makeDefault(dataSchema);
        createProperty(log, key, val);
      });

      // Add enumerable props directly for identifying logs; since these can't
      // be changed once set, they need no metadata, and should only be set once.
      setOnce(log, 'localID', props.localID);
      setOnce(log, 'id', props.id);
      setOnce(log, 'url', props.url);

      // Record metadata for the last time the log was synced (defaults to 0).
      Object.defineProperty(log, lastSync, {
        enumerable: false,
        value: _lastSync,
      });

      // Once an id has been assigned by the server, freeze the type and prevent
      // the object from being extended. Otherwise, keep the type writable and
      // allow properties to be changed depending on type.
      if (log.id) {
        setOnce(log, 'type', type);
        Object.preventExtensions(log);
      } else {
        createTypeProperty(log, type);
      }

      return log;
    },
    formatLogForServer(log) {
      const serverLog = { ...log };
      delete serverLog.localID;
      return serverLog;
    },
    mergeLogFromServer(localLog, _serverLog) {
      // Clean up the server response by coercing strings to numbers, numbers
      // to bools.
      const serverLog = {
        ..._serverLog,
        changed: +_serverLog.changed,
        timestamp: +_serverLog.timestamp,
        done: !!+_serverLog.done,
      };

      // Main logic for merging log properties between the server and local device.
      function mergeProps(key) {
        const sym = symbolRegistry[key];
        // If the server log changed more recently than the local log, and
        // the local log was synced more recently than it changed,
        // use the server log's value.
        if (serverLog.changed > localLog[sym][changed]
          && localLog[lastSync] > localLog[sym][changed]) {
          localLog[sym][changed] = serverLog.changed;
          localLog[sym][data] = serverLog[key];
          return;
        }
        // If the local log changed more recently than server log, or
        // the local log was synced more recently than it changed,
        // keep the local log's value (ie, do nothing).
        if (serverLog.changed < localLog[sym][changed]
          || localLog[lastSync] > localLog[sym][changed]) {
          return;
        }
        // Otherwise, the server log changed since the last sync, while
        // the local log has outstanding changes, so we have a conflict.
        localLog[sym][conflicts].push({
          [changed]: serverLog.changed,
          [data]: serverLog[key],
        });
      }

      // Iterate over all fields for the given log type and merge the properties.
      Object.entries(logTypes[localLog.type].fields).forEach(([key, { type }]) => {
        // Due to a bug on the server, notes and other text_long fields sometimes
        // come from the server with value of [], which gets rejected if sent back
        // to the server, so we need to reset it to null to correct the error.
        if (type === 'text_long' && Array.isArray(serverLog[key])) {
          serverLog[key] = null;
        }
        mergeProps(key);
      });

      if (localLog.id === undefined) {
        localLog.id = serverLog.id;
        localLog.url = serverLog.url;
      }

      localLog[lastSync] = Math.floor(Date.now() / 1000);
    },
    serializeLog(log) {
      const newLog = Object.keys(log).reduce((obj, key) => {
        const sym = symbolRegistry[key];
        // B/c some props, like id, aren't in the symbolRegistry and don't have metadata.
        if (!sym) {
          return { ...obj, [key]: log[key] };
        }
        return {
          ...obj,
          [key]: {
            data: log[sym][data],
            changed: log[sym][changed],
            conflicts: log[sym][conflicts],
          },
        };
      }, {});
      newLog.lastSync = log[lastSync];
      return newLog;
    },
    deserializeLog(log) {
      const newLog = {};
      Object.entries(log).forEach(([key, val]) => {
        const sym = symbolRegistry[key];
        // First handle the special cases of the lastSync & type props.
        if (key === 'lastSync') {
          newLog[lastSync] = val;
        } else if (key === 'type') {
          createTypeProperty(newLog, val);
        // Then any props that aren't in the symbol reg, like url & localID.
        } else if (!sym) {
          setOnce(newLog, key, val);
        // The rest should be regular props with metadata.
        } else {
          createProperty(newLog, key, val);
        }
      });
      return newLog;
    },
    getLastChange(log, key) {
      const sym = symbolRegistry[key];
      return log[sym][changed];
    },
    getLastSync(log) {
      return log[lastSync];
    },
    getConflicts(log) {
      return Object.entries(symbolRegistry).reduce((_conflicts, [key, sym]) => {
        if (log[sym][conflicts].length > 0) {
          return {
            ..._conflicts,
            [key]: log[sym][conflicts],
          };
        }
        return _conflicts;
      }, {});
    },
    resolveConflict(log, key, val) {
      const sym = symbolRegistry[key];
      log[sym][data] = val;
      log[sym][changed] = Math.floor(Date.now() / 1000);
      log[sym][conflicts] = [];
    },
  };
}

export const {
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
} = farmLog(defaultResources.log);
