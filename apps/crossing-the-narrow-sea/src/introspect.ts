import { GraphQLClient, gql } from 'graphql-request'
import fetch from 'cross-fetch'

const endpoint =
  process.env.SUBQL_ENDPOINT || 'https://subql.blue.taurus.subspace.network/v1/graphql'
const client = new GraphQLClient(endpoint, { fetch })

const INTROSPECT_QUERY_ROOT = gql`
  query IntrospectQueryRoot {
    __schema {
      queryType {
        name
        fields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
`

const INTROSPECT_TYPE_FIELDS = gql`
  query IntrospectType($name: String!) {
    __type(name: $name) {
      name
      fields {
        name
      }
    }
  }
`

const getNamedType = (t: any): string | null => {
  if (!t) return null
  if (t.name) return t.name
  if (t.ofType) return getNamedType(t.ofType)
  return null
}

const main = async () => {
  const { __schema } = await client.request<any>(INTROSPECT_QUERY_ROOT)
  const fields: Array<{ name: string; type: any }> = __schema.queryType.fields

  const nameMatches = (s: string) => /consensus|transfer|xdm|domain|evm|balance|balances/i.test(s)
  const candidates = fields
    .filter((f) => nameMatches(f.name))
    .map((f) => ({ name: f.name, typeName: getNamedType(f.type) }))

  const uniqueCandidates: Array<{ name: string; typeName: string | null }> = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const key = `${c.name}|${c.typeName ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueCandidates.push(c)
    }
  }

  const detailed: Array<{ name: string; typeName: string; fields: string[] }> = []
  for (const c of uniqueCandidates.slice(0, 50)) {
    if (!c.typeName) continue
    const res = await client.request<any>(INTROSPECT_TYPE_FIELDS, {
      name: c.typeName,
    })
    const typeFields: string[] = res.__type?.fields?.map((f: any) => f.name) ?? []
    detailed.push({ name: c.name, typeName: c.typeName, fields: typeFields })
  }

  const likelyTransfers = detailed.filter((d) =>
    d.fields.some((f) => ['from', 'to', 'from_chain', 'to_chain', 'timestamp'].includes(f)),
  )

  console.log(JSON.stringify({ endpoint, candidates: detailed, likelyTransfers }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
