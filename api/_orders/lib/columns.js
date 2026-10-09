// New columns arrive with later phases' database scripts, but the website is
// published the moment code is pushed. So a read that uses newer columns falls
// back to the older column list if the database does not have them yet — the
// TV board must keep working while a script is still waiting to be run.
//
//   run(cols) must return the Supabase query promise for that column list.
export async function selectTolerant(run, fullCols, basicCols) {
  const first = await run(fullCols)
  if (!first.error) return first
  if (/column .* does not exist|could not find .* column/i.test(first.error.message || '')) {
    console.warn(`Database is missing a newer column (${first.error.message}); using the older column list. Run the latest supabase/phase*.sql.`)
    return run(basicCols)
  }
  return first
}
