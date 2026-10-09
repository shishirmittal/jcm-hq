import { supabase } from './supabase.js'

export async function uploadPhotos(projectId, files, onProgress) {
  const { data: { user } } = await supabase.auth.getUser()

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (onProgress) onProgress(i + 1, files.length)

    const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    const path = `${projectId}/${Date.now()}-${safeName}`

    const { error: upErr } = await supabase.storage.from('project-photos').upload(path, file)
    if (upErr) continue

    const { data: { publicUrl } } = supabase.storage.from('project-photos').getPublicUrl(path)
    await supabase.from('project_photos').insert([{ project_id: projectId, url: publicUrl, path, created_by: user.id }])
  }
}

export async function deletePhoto(photo) {
  await supabase.storage.from('project-photos').remove([photo.path])
  await supabase.from('project_photos').delete().eq('id', photo.id)
}
