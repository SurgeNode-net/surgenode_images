fx_version 'cerulean'
game 'common'
lua54 'yes'

name 'surgenode_images'
author 'SurgeNode'
description 'Syncs ox_inventory item images to the SurgeNode image CDN (images.surgenode.net)'
version '0.3.1'

server_scripts {
  'client_images.lua',
  'server.js',
}
