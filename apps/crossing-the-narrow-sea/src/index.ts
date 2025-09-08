const main = async (): Promise<void> => {
  console.log('[crossing-the-narrow-sea] Ready. ')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
