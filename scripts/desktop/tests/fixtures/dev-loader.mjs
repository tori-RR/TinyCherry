const dev = new URL('../../dev.mjs', import.meta.url).href
const adapter = new URL('./dev-adapter.mjs', import.meta.url).href

export async function resolve(specifier, context, next) {
  if (context.parentURL === dev && ['./process.mjs', './candidate.mjs', './helper.mjs'].includes(specifier))
    return { url: adapter, shortCircuit: true }
  return next(specifier, context)
}
