## Drizzle Usage

- Schema entry: `src/database/schema/index.ts`
- Database token: `DRIZZLE_DB`
- Injected wrapper: `DatabaseService`
- SQLite path: `DATABASE_URL`, default `./data/kimiko.sqlite`

Generate the next migration after editing schema files:

```bash
pnpm db:generate
```

Apply migrations to the local SQLite database:

```bash
pnpm db:migrate
```
