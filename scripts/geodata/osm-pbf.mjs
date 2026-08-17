/**
 * Чтение OSM PBF без сторонних библиотек.
 *
 * Зависимость ради разового служебного скрипта означала бы, что воспроизвести
 * геометрию МКАД можно только с работающим реестром пакетов нужной версии.
 * Здесь достаточно Node: формат описан в OSMPBF (`fileformat.proto`,
 * `osmformat.proto`), и читается ровно то, что нужно, — отношение, его линии
 * и координаты их узлов.
 *
 * Читатель НИЧЕГО не додумывает: неизвестные поля пропускаются по типу
 * провода, а не угадываются.
 */

import { createReadStream } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Разбор одного protobuf-сообщения. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.buffer.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buffer[this.pos];
      this.pos += 1;
      if (byte === undefined) {
        throw new Error('PBF: неожиданный конец сообщения');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
  }

  /** Ключ поля: номер и тип провода. */
  key() {
    const value = this.varint();
    return { field: Number(value >> 3n), wire: Number(value & 7n) };
  }

  bytes() {
    const length = Number(this.varint());
    const slice = this.buffer.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  /** Пропуск поля неизвестного назначения. */
  skip(wire) {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 2) {
      this.bytes();
      return;
    }
    if (wire === 5) {
      this.pos += 4;
      return;
    }
    if (wire === 1) {
      this.pos += 8;
      return;
    }
    throw new Error(`PBF: неизвестный тип провода ${wire}`);
  }
}

/** Зигзаг: так protobuf хранит знаковые числа. */
function zigzag(value) {
  return (value >> 1n) ^ -(value & 1n);
}

function packedVarints(buffer) {
  const reader = new Reader(buffer);
  const values = [];
  while (!reader.done) {
    values.push(reader.varint());
  }
  return values;
}

function packedSigned(buffer) {
  return packedVarints(buffer).map(zigzag);
}

/**
 * Последовательное чтение блоков файла.
 *
 * Файл — это цепочка «длина заголовка → BlobHeader → Blob». Читается потоком:
 * снимок целиком в память класть незачем.
 */
async function* blobs(filePath) {
  const stream = createReadStream(filePath);
  let buffered = Buffer.alloc(0);

  const take = (length) => {
    if (buffered.length < length) {
      return null;
    }
    const head = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return head;
  };

  let pending = null;

  for await (const chunk of stream) {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

    for (;;) {
      if (pending === null) {
        const size = take(4);
        if (size === null) {
          break;
        }
        pending = { headerLength: size.readUInt32BE(0), header: null };
      }

      if (pending.header === null) {
        const header = take(pending.headerLength);
        if (header === null) {
          break;
        }
        pending.header = parseBlobHeader(header);
      }

      const body = take(pending.header.dataSize);
      if (body === null) {
        break;
      }

      const type = pending.header.type;
      pending = null;
      yield { type, payload: parseBlob(body) };
    }
  }
}

function parseBlobHeader(buffer) {
  const reader = new Reader(buffer);
  let type = '';
  let dataSize = 0;
  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 2) {
      type = reader.bytes().toString('utf8');
    } else if (field === 3 && wire === 0) {
      dataSize = Number(reader.varint());
    } else {
      reader.skip(wire);
    }
  }
  return { type, dataSize };
}

function parseBlob(buffer) {
  const reader = new Reader(buffer);
  let raw = null;
  let zlibData = null;
  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 2) {
      raw = reader.bytes();
    } else if (field === 3 && wire === 2) {
      zlibData = reader.bytes();
    } else {
      reader.skip(wire);
    }
  }
  if (zlibData !== null) {
    return inflateSync(zlibData);
  }
  if (raw !== null) {
    return raw;
  }
  throw new Error('PBF: блок сжат неподдерживаемым способом (ожидались raw или zlib)');
}

/**
 * Разбор PrimitiveBlock ровно в нужном объёме.
 *
 * `want` говорит, что именно интересует на этом проходе. Всё остальное
 * пропускается без разбора: узлов в снимке десятки миллионов, и разбирать их
 * ради поиска отношения — время, потраченное впустую.
 */
function parsePrimitiveBlock(buffer, want, visit) {
  const reader = new Reader(buffer);
  const groups = [];
  const strings = [];
  let granularity = 100;
  let latOffset = 0n;
  let lonOffset = 0n;

  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 2) {
      // Таблица строк блока: ключи, значения и роли ссылаются на её номера.
      const table = new Reader(reader.bytes());
      while (!table.done) {
        const entry = table.key();
        if (entry.field === 1 && entry.wire === 2) {
          strings.push(table.bytes().toString('utf8'));
        } else {
          table.skip(entry.wire);
        }
      }
    } else if (field === 2 && wire === 2) {
      groups.push(reader.bytes());
    } else if (field === 17 && wire === 0) {
      granularity = Number(reader.varint());
    } else if (field === 19 && wire === 0) {
      latOffset = reader.varint();
    } else if (field === 20 && wire === 0) {
      lonOffset = reader.varint();
    } else {
      reader.skip(wire);
    }
  }

  for (const group of groups) {
    parseGroup(group, { granularity, latOffset, lonOffset, strings }, want, visit);
  }
}

function parseGroup(buffer, frame, want, visit) {
  const reader = new Reader(buffer);
  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 2 && wire === 2 && want.nodes) {
      parseDenseNodes(reader.bytes(), frame, visit);
    } else if (field === 3 && wire === 2 && want.ways) {
      parseWay(reader.bytes(), frame, visit);
    } else if (field === 4 && wire === 2 && want.relations) {
      parseRelation(reader.bytes(), frame, visit);
    } else {
      reader.skip(wire);
    }
  }
}

function parseDenseNodes(buffer, frame, visit) {
  const reader = new Reader(buffer);
  let ids = [];
  let lats = [];
  let lons = [];

  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 2) {
      ids = packedSigned(reader.bytes());
    } else if (field === 8 && wire === 2) {
      lats = packedSigned(reader.bytes());
    } else if (field === 9 && wire === 2) {
      lons = packedSigned(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }

  let id = 0n;
  let lat = 0n;
  let lon = 0n;
  for (let index = 0; index < ids.length; index += 1) {
    id += ids[index] ?? 0n;
    lat += lats[index] ?? 0n;
    lon += lons[index] ?? 0n;
    visit.node?.(
      id,
      Number(frame.latOffset + BigInt(frame.granularity) * lat) / 1e9,
      Number(frame.lonOffset + BigInt(frame.granularity) * lon) / 1e9,
    );
  }
}

function parseWay(buffer, frame, visit) {
  const reader = new Reader(buffer);
  let id = 0n;
  let refs = [];
  let keys = [];
  let vals = [];

  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 0) {
      id = reader.varint();
    } else if (field === 2 && wire === 2) {
      keys = packedVarints(reader.bytes()).map(Number);
    } else if (field === 3 && wire === 2) {
      vals = packedVarints(reader.bytes()).map(Number);
    } else if (field === 8 && wire === 2) {
      refs = packedSigned(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }

  if (visit.way === undefined) {
    return;
  }

  const nodes = [];
  let ref = 0n;
  for (const delta of refs) {
    ref += delta;
    nodes.push(ref);
  }
  visit.way(id, nodes, tagsOf(keys, vals, frame.strings));
}

function parseRelation(buffer, frame, visit) {
  const reader = new Reader(buffer);
  let id = 0n;
  let roleIds = [];
  let memberDeltas = [];
  let types = [];
  let keys = [];
  let vals = [];

  while (!reader.done) {
    const { field, wire } = reader.key();
    if (field === 1 && wire === 0) {
      id = reader.varint();
    } else if (field === 2 && wire === 2) {
      keys = packedVarints(reader.bytes()).map(Number);
    } else if (field === 3 && wire === 2) {
      vals = packedVarints(reader.bytes()).map(Number);
    } else if (field === 8 && wire === 2) {
      roleIds = packedVarints(reader.bytes()).map(Number);
    } else if (field === 9 && wire === 2) {
      memberDeltas = packedSigned(reader.bytes());
    } else if (field === 10 && wire === 2) {
      types = packedVarints(reader.bytes()).map(Number);
    } else {
      reader.skip(wire);
    }
  }

  if (visit.relation === undefined) {
    return;
  }

  const members = [];
  let member = 0n;
  for (let index = 0; index < memberDeltas.length; index += 1) {
    member += memberDeltas[index] ?? 0n;
    members.push({
      ref: member,
      type: ['NODE', 'WAY', 'RELATION'][types[index] ?? 0] ?? 'NODE',
      role: frame.strings[roleIds[index] ?? 0] ?? '',
    });
  }
  visit.relation(id, members, tagsOf(keys, vals, frame.strings));
}

/** Метки сущности: номера в таблице строк блока — в обычные пары. */
function tagsOf(keys, vals, strings) {
  const tags = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = strings[keys[index] ?? 0];
    const value = strings[vals[index] ?? 0];
    if (key !== undefined && value !== undefined) {
      tags[key] = value;
    }
  }
  return tags;
}

/**
 * Один проход по файлу.
 *
 * `want` включает разбор только нужных сущностей: три прицельных прохода
 * дешевле одного всеядного, потому что узлы разбираются ровно один раз и
 * только те, что действительно нужны.
 */
export async function scan(filePath, want, visit) {
  for await (const blob of blobs(filePath)) {
    if (blob.type !== 'OSMData') {
      continue;
    }
    parsePrimitiveBlock(blob.payload, want, visit);
  }
}
