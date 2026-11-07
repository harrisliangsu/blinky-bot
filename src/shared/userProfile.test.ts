import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileImageSource, MAX_PROFILE_IMAGE_LENGTH } from './userProfile.ts'
import { normaliseSettings } from '../main/settingsSchema.ts'

function header(width=256,height=256): string {
  const png=Buffer.alloc(24);png.write('\x89PNG\r\n\x1a\n',0,'binary');png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(width,16);png.writeUInt32BE(height,20)
  return 'data:image/png;base64,'+png.toString('base64')
}
test('user avatar accepts bounded raster data without paths or remote image URLs',()=>{
  assert.equal(profileImageSource(header()),header())
  for(const input of [undefined,'','https://example.invalid/avatar.png','file:///private/photo.png','data:image/svg+xml;base64,PHN2Zz4=',header(257),header(0),header(1,8192),header()+'?', 'data:image/png;base64,'+'A'.repeat(MAX_PROFILE_IMAGE_LENGTH)])assert.equal(profileImageSource(input),null)
})
test('legacy identity and unrelated settings survive normalisation',()=>{
  const old=normaliseSettings({profileName:'  Legacy User  ',profileEmoji:'L',profileColor:'#123456',denylist:['keep']})
  assert.equal(old.profileName,'Legacy User');assert.equal(old.profileEmoji,'L');assert.equal(old.profileColor,'#123456');assert.equal(old.profileImage,'');assert.deepEqual(old.denylist,['keep'])
  assert.equal(normaliseSettings({...old,profileImage:'https://example.invalid/photo'}).profileImage,'')
  assert.equal(normaliseSettings({...old,profileImage:header()}).profileImage,header())
})
