# Tutorial: build your first domain pack

Open Foundry ships no domain of its own. Everything a deployment knows — its
object types, the actions that may change them, and who is allowed to do what —
comes from a **domain pack**. This tutorial builds one from scratch.

The worked example is a small **library lending** domain, chosen because it is
recognisable and has nothing to do with healthcare: the bundled `nhs-acute` pack
is a reference implementation, not a template you have to follow.

The finished pack is in [`../examples/library-pack/`](../examples/library-pack/)
if you would rather read it whole first.

**You will build:** two object types, a link between them, two governed actions
with preconditions, a permission model, and seed data — then load it and lend a
book through the API.

**Prerequisites:** the stack running per the [deployment
guide](../deploy/README.md), and about twenty minutes.

---

## 1. The manifest

A pack is a directory with a `pack.yaml` that lists its parts. Create
`library-pack/pack.yaml`:

```yaml
name: library
version: 0.1.0
namespace: example.library
description: "A small library lending domain"

dependencies:
  openfoundry.core: ">=1.0.0"

schema:
  - schema/enums.odl
  - schema/book.odl
  - schema/member.odl
  - schema/links.odl
  - schema/actions.odl

actions:
  - actions/borrow-book.yaml
  - actions/return-book.yaml

permissions:
  - permissions/library-roles.fga

seed:
  - seeds/catalogue.yaml
```

Only `name`, `version` and `namespace` are required; every other section is
optional. Files are loaded in the order listed, so define enums before the types
that use them.

## 2. Model the domain

ODL is GraphQL SDL plus semantic directives. `schema/enums.odl`:

```graphql
extend schema @namespace(name: "example.library", version: "0.1.0")

enum BookStatus {
  AVAILABLE
  ON_LOAN
  WITHDRAWN
}
```

`schema/book.odl`:

```graphql
extend schema @namespace(name: "example.library", version: "0.1.0")

type Book @objectType {
  id: ID! @primary
  isbn: String @unique @indexed
  title: String! @indexed @searchable(weight: 2.0)
  author: String!
  status: BookStatus!

  borrower: Member @link(type: "BorrowedBy", direction: OUTBOUND)
}
```

`@objectType` makes it a first-class entity: it gets storage, REST and GraphQL
surfaces, version history, and an entry in the authorization model. `@unique`
and `@indexed` shape the database; `@searchable` feeds full-text search.

`schema/member.odl` introduces one more idea:

```graphql
type Member @objectType {
  id: ID! @primary
  memberNumber: String @unique @indexed
  name: String! @indexed
  email: String @sensitive

  books: [Book!]! @link(type: "BorrowedBy", direction: INBOUND)
}
```

`@sensitive` marks a field as one that should not be handed out freely. It is a
declaration of intent and **does not redact on its own** — redaction engages for
a type only once you add a field-permissions file, which we do in step 4.

Relationships are their own type, so they can carry properties.
`schema/links.odl`:

```graphql
type BorrowedBy @linkType(from: "Book", to: "Member", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  borrowedAt: DateTime!
  dueAt: DateTime
}
```

`MANY_TO_ONE` means many books to one member, and the engine enforces it.

## 3. Declare the actions

**Objects are never created or edited directly.** There is no generic CRUD write
path — every mutation goes through an action, which is what makes preconditions,
authorization, audit and events unavoidable rather than optional.

An action has two halves. The ODL declares its shape, in `schema/actions.odl`:

```graphql
type BorrowBook @actionType(permission: "can_borrow") {
  book: Book! @param
  member: Member! @param
  dueAt: DateTime @param
}

type ReturnBook @actionType(permission: "can_return") {
  book: Book! @param
}
```

The first `@param` whose type is an ObjectType is the **authorization target** —
here `Book`, so permission is checked on the specific book being borrowed.

`permission:` names the relation to check. It is optional: without it the name is
derived from the action name, but that derivation strips words matching
ObjectType names, so introducing an unrelated type later can silently rename the
relation. Declaring it is cheap insurance.

The manifest supplies the behaviour, in `actions/borrow-book.yaml`:

```yaml
action: BorrowBook
version: 1
reversible: false

preconditions:
  - expr: "book.status == 'AVAILABLE'"
    error: "That book is not available to borrow"
  - expr: "actor.hasRole('librarian') || actor.hasRole('admin')"
    error: "Only librarians may lend books"

effects:
  - type: updateObject
    target: "book"
    set:
      status: "ON_LOAN"

  - type: createLink
    linkType: "BorrowedBy"
    from: "book"
    to: "member"
    properties:
      borrowedAt: "now"
      dueAt: "params.dueAt"

sideEffects:
  - name: emitBorrowedEvent
    type: event
    config:
      type: "example.library.book.borrowed"
      data:
        bookId: "book.id"
        memberId: "member.id"

rollback:
  onSideEffectFailure: ROLLBACK_ALL
```

Preconditions are CEL expressions evaluated against the resolved parameters;
failing one aborts the action with your error message and nothing is written.
All effects run in a single transaction. Side effects fire *after* commit, and
`ROLLBACK_ALL` runs a compensating transaction if one fails.

`ReturnBook` is the mirror image — set the status back and delete the link:

```yaml
effects:
  - type: updateObject
    target: "book"
    set:
      status: "AVAILABLE"

  - type: deleteLink
    linkType: "BorrowedBy"
    filter:
      from: "book"
      active: true
    expect: ALL
```

## 4. Write the permission model

This is the step most first packs get wrong, so it is worth slowing down.

Open Foundry generates a baseline OpenFGA model from your ODL. If you supply
your own `permissions/*.fga`, it **replaces the entire generated block for every
type it names** — it does not merge relation by relation. So each type you
declare must re-declare every relation the runtime checks:

- **`viewer`** — checked on every read. Omitting it does not restrict access, it
  *breaks reads entirely*: OpenFGA rejects a check against an undefined relation,
  and in production the gateway refuses to start rather than run without it.
- **`can_<verb>`** — the relation each action targeting that type checks.

`permissions/library-roles.fga`:

```
model
  schema 1.1

type user

type book
  relations
    define librarian: [user]
    define admin: [user]
    define viewer: [user] or librarian or admin
    define editor: librarian or admin
    define can_borrow: librarian or admin
    define can_return: librarian or admin

type member
  relations
    define librarian: [user]
    define admin: [user]
    define viewer: librarian or admin
    define editor: admin
```

Type names are snake_case of the ODL name. `[user]` means directly assignable —
someone must be granted it explicitly, through the relationships API. The other
relations are computed from those grants.

Boot validation checks this contract and names the offending type if something
is missing, so a mistake here surfaces at startup rather than as a confusing 500
on first read.

### Field-level redaction

The `.fga` model decides who may read an *object*. Which *fields* they get back
is a separate file, `permissions/field-permissions.yaml`, discovered by
convention — it is not listed under `permissions:` in `pack.yaml`, which only
takes `.fga` files.

```yaml
- objectType: Member
  alwaysVisible:
    - id
    - memberNumber
    - name
    - books
  fieldsByRelation:
    librarian:
      - email
    admin:
      - email
```

This is the part that catches people: **marking a field `@sensitive` protects
nothing by itself.** Redaction only engages for object types that appear in this
file. Once a type does appear, the rule inverts — every field is hidden unless
it is in `alwaysVisible` or granted to one of the caller's roles, and that
includes link fields like `books`, which is why it is listed above.

Responses carry a `_redactedFields` array naming what was withheld.

## 5. Seed reference data

Books and members have no creating action — they exist before anyone borrows
anything. Boot seeds fill that gap, in `seeds/catalogue.yaml`:

```yaml
objects:
  - type: Book
    ref: book-dune
    fields:
      isbn: "9780441013593"
      title: "Dune"
      author: "Frank Herbert"
      status: AVAILABLE

  - type: Member
    ref: member-ada
    fields:
      memberNumber: "M-0001"
      name: "Ada Lovelace"
      email: "ada@example.org"

links: []
```

Seeds are idempotent, so restarting does not duplicate them. `ref` labels let
links reference objects created in the same seed.

> **The trap:** seeds are written under `SEED_TENANT`, which defaults to the
> isolated `system` tenant. Reads are tenant-scoped, so with the default your
> data is stored correctly but **invisible** to API queries — the boot log will
> cheerfully say `Seed: created 3 object(s)`. Set `SEED_TENANT` to the tenant
> your requests use.

## 6. Load the pack

Point the gateway at your pack directory and name it in `DOMAIN_PACKS`:

```bash
cd deploy
DOMAIN_PACKS_HOST_DIR=../examples/library-pack \
DOMAIN_PACKS_EXTRA_DIRS=/external-packs \
DOMAIN_PACKS=core,library \
SEED_TENANT=default \
docker compose -f docker-compose.yaml up -d --wait
```

`DOMAIN_PACKS_HOST_DIR` is the host path mounted into the container;
`DOMAIN_PACKS_EXTRA_DIRS` is where the gateway looks inside it. Omit
`DOMAIN_PACKS` to load every pack it discovers.

Check the boot log first — it reports what loaded and warns about anything
missing:

```bash
docker compose logs api-gateway | grep -E "Schema:|Seed:|Capabilities:"
```

You should see your object and link types counted, and `Seed: created 3
object(s) ... (tenant 'default')`.

## 7. Lend a book

The default stack runs in development mode, so no token is needed. Reads are on
the plural, lower-cased type name:

```bash
curl -s localhost:4000/api/v1/books | jq '.data[] | {id, title, status}'
```

Borrow one by calling the action with the two object ids:

```bash
curl -s -X POST localhost:4000/api/v1/actions/BorrowBook \
  -H 'content-type: application/json' \
  -d '{"book":"<book-id>","member":"<member-id>","dueAt":"2026-12-01T00:00:00Z"}' | jq
```

A success returns `data.success: true` and the objects it changed. Read the book
back and its status is `ON_LOAN`. Call the same action again and the precondition
rejects it — `That book is not available to borrow` — with nothing written.

Everything else follows from the schema: the book is queryable over GraphQL, its
history is at `/api/v1/books/<id>/history`, and the borrow emitted an event on
the bus.

> Development mode replaces authorization and CEL with allow-all stubs, so the
> role checks in your preconditions are **not** enforced here. To see them bite,
> run in production mode — see
> [development vs production](../deploy/README.md#development-mode-vs-production-mode).

## Where to go next

- [`external-domain-packs.md`](external-domain-packs.md) — the full reference:
  connectors, capabilities, configuration, and troubleshooting.
- [`open-foundry-spec-v2.md`](open-foundry-spec-v2.md) — ODL directives, the
  action framework, and the security model in depth.
- The bundled packs under [`../domain-packs/`](../domain-packs/) as larger worked
  examples — `aml` and `supply-chain` are non-healthcare; `nhs-acute` exercises
  the most platform features.

### The four that catch people out

1. **A permission override replaces the whole type.** Re-declare `viewer` and
   every `can_<verb>`, or reads break and production will not boot.
2. **Seeds default to the `system` tenant.** Set `SEED_TENANT` or your data is
   there but invisible.
3. **`@sensitive` alone redacts nothing.** A type is only redacted once it
   appears in `permissions/field-permissions.yaml`.
4. **Development mode enforces nothing.** A passing action in dev proves the
   pipeline ran, not that your permissions are correct — the synthetic dev user
   holds every role, so it sees every field.
