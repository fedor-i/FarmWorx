// Gives sql.js the same small interface as node:sqlite, so the app logic runs unchanged in a browser.
const bindable = (args) => args.map((value) => value ?? null);

export function wrapSqlJs(raw) {
  const query = (sql, args, read) => {
    const statement = raw.prepare(sql);
    try {
      statement.bind(bindable(args));
      return read(statement);
    } finally {
      statement.free();
    }
  };

  return {
    exec: (sql) => raw.run(sql),
    prepare: (sql) => ({
      run(...args) {
        raw.run(sql, bindable(args));
        return { changes: raw.getRowsModified() };
      },
      get: (...args) => query(sql, args, (statement) => (statement.step() ? statement.getAsObject() : undefined)),
      all: (...args) => query(sql, args, (statement) => {
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      }),
    }),
  };
}
