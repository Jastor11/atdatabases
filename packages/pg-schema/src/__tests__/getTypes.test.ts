import connect, {sql, DataTypeID} from '@databases/pg';
import getTypes, {Type} from '../getTypes';
import TypeCateogry from '../enums/TypeCategory';
import {readFileSync, writeFileSync} from 'fs';
import TypeKind from '../enums/TypeKind';
const prettier = require('prettier');

const db = connect();

// int8 default for pg-promise is string
// but @databases/pg uses number

const INTERVAL =
  '{years: number,months: number,days: number,hours: number,minutes: number,seconds: number,milliseconds: number, toPostgres: () => string, toISO: () => string}';

const typeMappings: {[key in DataTypeID]?: string} = {
  [DataTypeID.bool]: 'boolean',
  [DataTypeID.bytea]: 'Buffer',
  [DataTypeID.circle]: '{x: number, y: number, radius: number}',
  [DataTypeID.float4]: 'number',
  [DataTypeID.int2]: 'number',
  [DataTypeID.int8]: 'number',
  [DataTypeID.interval]: INTERVAL,
  [DataTypeID.json]: 'any',
  [DataTypeID.jsonb]: 'any',
  [DataTypeID.point]: '{x: number, y: number}',
  [DataTypeID.timestamp]: 'Date',
  [DataTypeID._bool]: 'Array<boolean | nul>',
  [DataTypeID._bytea]: 'Array<Buffer | null>',
  [DataTypeID._int2]: 'Array<number | null>',
  [DataTypeID._int8]: 'Array<number | null>',
  [DataTypeID._interval]: `Array<${INTERVAL} | null>`,
  [DataTypeID._json]: 'Array<any | null>',
  [DataTypeID._numeric]: 'Array<number | null>',
  [DataTypeID._point]: 'Array<{x: number, y: number} | null>',
  [DataTypeID._text]: 'Array<string | null>',
  [DataTypeID._timestamp]: 'Array<Date | null>',
};

async function writeIfDifferent(filename: string, content: string) {
  const prettierOptions = (await prettier.resolveConfig(filename)) || {};
  prettierOptions.parser = 'typescript';
  const formatted = prettier.format(content, prettierOptions);
  try {
    if (readFileSync(filename, 'utf8') === formatted) {
      return;
    }
  } catch (ex) {
    if (ex.code !== 'ENOENT') throw ex;
  }
  writeFileSync(filename, formatted);
}

test('get built in types', async () => {
  const builtInTypes = await getTypes(db, {schemaName: 'pg_catalog'});
  const groupedTypes = builtInTypes.reduce<{[key: string]: Type[]}>(
    (result, ty) => {
      const category = Object.keys(TypeCateogry).find(
        (c) => (TypeCateogry as any)[c] === ty.category,
      )!;
      result[category] = (result[category] || []).concat([ty]);
      return result;
    },
    {},
  );
  expect(
    Object.keys(groupedTypes)
      .sort()
      .reduce<{[key: string]: string[]}>((result, key) => {
        return {
          ...result,
          [key]: groupedTypes[key].map(
            (ty) =>
              `${ty.typeID} = ${ty.typeName}` +
              ('subtypeName' in ty && ty.subtypeName
                ? `<${ty.subtypeName}>`
                : '') +
              (ty.comment ? ' // ' + ty.comment : ''),
          ),
        };
      }, {}),
  ).toMatchSnapshot();

  const PgDataTypeIDsEnum = [
    '// autogenerated by test suite of pg-schema',
    '',
    'enum PgDataTypeID {',
  ];
  Object.keys(groupedTypes).forEach((groupName, i) => {
    if (i !== 0) PgDataTypeIDsEnum.push('');
    PgDataTypeIDsEnum.push(`  // === ${groupName} ===`);
    groupedTypes[groupName].forEach((type) => {
      PgDataTypeIDsEnum.push('');
      const commentLines = [];
      if (type.comment) {
        commentLines.push(type.comment);
      }
      if (type.kind === TypeKind.Array) {
        commentLines.push(`Array<${type.subtypeName}>`);
      }
      if (commentLines.length) {
        PgDataTypeIDsEnum.push(`  /**`);
        commentLines.forEach((commentLine, j) => {
          if (j !== 0) {
            PgDataTypeIDsEnum.push(`   *`);
          }
          PgDataTypeIDsEnum.push(`   * ${commentLine}`);
        });
        PgDataTypeIDsEnum.push(`   */`);
      }
      PgDataTypeIDsEnum.push(`  ${type.typeName} = ${type.typeID},`);
    });
  });
  PgDataTypeIDsEnum.push(`}`);
  PgDataTypeIDsEnum.push(``);
  PgDataTypeIDsEnum.push(`export default PgDataTypeID;`);
  PgDataTypeIDsEnum.push(`module.exports = PgDataTypeID;`);
  PgDataTypeIDsEnum.push(`module.exports.default = PgDataTypeID;`);
  PgDataTypeIDsEnum.push(``);
  await writeIfDifferent(
    __dirname + '/../../../pg-data-type-id/src/index.ts',
    PgDataTypeIDsEnum.join('\n'),
  );

  const pgTypes = require('pg-types/lib/textParsers');
  const mapping = new Map<number, unknown>();
  const reverseMapping = new Map<unknown, number[]>();
  pgTypes.init((id: number, parser: unknown) => {
    mapping.set(id, parser);
    const m = reverseMapping.get(parser) || [];
    reverseMapping.set(parser, [...m, id]);
  });
  const typeMappingLines: string[] = [];
  mapping.forEach((parser, id) => {
    const allIDs = reverseMapping.get(parser) || [];
    const idsWithMapping = allIDs.filter((typeID) => typeID in typeMappings);
    if (idsWithMapping.length === 0) {
      throw new Error(
        'There is no mapping for: ' +
          allIDs.map((typeID) => DataTypeID[typeID]).join(', '),
      );
    }
    if (idsWithMapping.length > 1) {
      throw new Error(
        'There is ambiguity between: ' +
          idsWithMapping.map((typeID) => DataTypeID[typeID]).join(', '),
      );
    }
    typeMappingLines.push(
      `  [DataTypeID.${DataTypeID[id]}]: '${
        (typeMappings as any)[idsWithMapping[0]]
      }',`,
    );
  });
  const DefaultTypeScriptMapping = [
    `// autognerated by getTypes test`,
    ``,
    `import {DataTypeID} from '@databases/pg';`,
    ``,
    `const DefaultTypeScriptMapping: {[key in DataTypeID]?: string} = {`,
    ...typeMappingLines.sort(),
    `};`,
    ``,
    `export default DefaultTypeScriptMapping;`,
  ];
  await writeIfDifferent(
    __dirname + '/../DefaultTypeScriptMapping.ts',
    DefaultTypeScriptMapping.join('\n'),
  );
});

test('get custom types', async () => {
  await db.query(sql`CREATE SCHEMA gettypes`);
  await db.query(
    sql`
      CREATE TYPE gettypes.currency AS ENUM('USD', 'GBP');
      COMMENT ON TYPE gettypes.currency IS 'Three character currency code';

      CREATE DOMAIN gettypes.email AS TEXT CHECK (VALUE ~ '^.+@.+$');
      COMMENT ON TYPE gettypes.email IS 'An email address';

      CREATE TYPE gettypes.money_with_currency AS (
        value MONEY,
        currency gettypes.currency
      );
      COMMENT ON TYPE gettypes.money_with_currency IS 'A monetary value with currency';
    `,
  );
  await db.query(
    sql`
      CREATE TABLE gettypes.tab (
        email gettypes.email NOT NULL PRIMARY KEY,
        money gettypes.money_with_currency
      );
    `,
  );
  await db.query(
    sql`
      INSERT INTO gettypes.tab (email, money) VALUES (${'forbes@lindesay.co.uk'}, ROW (${10}, 'USD'))
    `,
  );
  expect(await db.query(sql`SELECT * FROM gettypes.tab`))
    .toMatchInlineSnapshot(`
Array [
  Object {
    "email": "forbes@lindesay.co.uk",
    "money": "($10.00,USD)",
  },
]
`);
  expect(
    (await getTypes(db, {schemaName: 'gettypes'})).map((t) => {
      const result = {
        ...t,
        schemaID: typeof t.schemaID === 'number' ? '<oid>' : t.schemaID,
        typeID: typeof t.typeID === 'number' ? '<oid>' : t.typeID,
      };
      if ('subtypeID' in result && typeof result.subtypeID === 'number') {
        result.subtypeID = '<oid>' as any;
      }
      if ('basetypeID' in result && typeof result.basetypeID === 'number') {
        result.basetypeID = '<oid>' as any;
      }
      if ('classID' in result && typeof result.classID === 'number') {
        result.classID = '<oid>' as any;
      }
      if ('attributes' in result) {
        result.attributes = result.attributes.map((a) => ({
          ...a,
          classID: typeof a.classID === 'number' ? '<oid>' : a.classID,
          schemaID: typeof a.schemaID === 'number' ? '<oid>' : a.schemaID,
          typeID: typeof a.typeID === 'number' ? '<oid>' : a.typeID,
        })) as any[];
      }
      return result;
    }),
  ).toMatchInlineSnapshot(`
Array [
  Object {
    "category": "E",
    "comment": "Three character currency code",
    "kind": "e",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "typeID": "<oid>",
    "typeName": "currency",
    "values": Array [
      "USD",
      "GBP",
    ],
  },
  Object {
    "category": "A",
    "comment": null,
    "kind": "array",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "subtypeID": "<oid>",
    "subtypeName": "currency",
    "typeID": "<oid>",
    "typeName": "_currency",
  },
  Object {
    "basetypeID": "<oid>",
    "basetypeName": "text",
    "category": "S",
    "comment": "An email address",
    "kind": "d",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "typeID": "<oid>",
    "typeName": "email",
  },
  Object {
    "attributes": Array [
      Object {
        "attributeName": "value",
        "attributeNumber": 1,
        "classID": "<oid>",
        "className": "money_with_currency",
        "comment": null,
        "default": null,
        "hasDefault": false,
        "notNull": false,
        "schemaID": "<oid>",
        "schemaName": "gettypes",
        "typeID": "<oid>",
        "typeLength": -1,
      },
      Object {
        "attributeName": "currency",
        "attributeNumber": 2,
        "classID": "<oid>",
        "className": "money_with_currency",
        "comment": null,
        "default": null,
        "hasDefault": false,
        "notNull": false,
        "schemaID": "<oid>",
        "schemaName": "gettypes",
        "typeID": "<oid>",
        "typeLength": -1,
      },
    ],
    "category": "C",
    "classID": "<oid>",
    "comment": "A monetary value with currency",
    "kind": "c",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "typeID": "<oid>",
    "typeName": "money_with_currency",
  },
  Object {
    "category": "A",
    "comment": null,
    "kind": "array",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "subtypeID": "<oid>",
    "subtypeName": "money_with_currency",
    "typeID": "<oid>",
    "typeName": "_money_with_currency",
  },
  Object {
    "attributes": Array [
      Object {
        "attributeName": "email",
        "attributeNumber": 1,
        "classID": "<oid>",
        "className": "tab",
        "comment": null,
        "default": null,
        "hasDefault": false,
        "notNull": true,
        "schemaID": "<oid>",
        "schemaName": "gettypes",
        "typeID": "<oid>",
        "typeLength": -1,
      },
      Object {
        "attributeName": "money",
        "attributeNumber": 2,
        "classID": "<oid>",
        "className": "tab",
        "comment": null,
        "default": null,
        "hasDefault": false,
        "notNull": false,
        "schemaID": "<oid>",
        "schemaName": "gettypes",
        "typeID": "<oid>",
        "typeLength": -1,
      },
    ],
    "category": "C",
    "classID": "<oid>",
    "comment": null,
    "kind": "c",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "typeID": "<oid>",
    "typeName": "tab",
  },
  Object {
    "category": "A",
    "comment": null,
    "kind": "array",
    "schemaID": "<oid>",
    "schemaName": "gettypes",
    "subtypeID": "<oid>",
    "subtypeName": "tab",
    "typeID": "<oid>",
    "typeName": "_tab",
  },
]
`);
});
