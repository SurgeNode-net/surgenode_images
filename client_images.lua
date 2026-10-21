local function loadData(res, file)
  local src = LoadResourceFile(res, file)
  if not src then return end
  local env = setmetatable({}, { __index = _G })
  local fn = load(src, ('@@%s/%s'):format(res, file), 't', env)
  if not fn then return end
  local ok, out = pcall(fn)
  if ok and type(out) == 'table' then return out end
end

local function addImages(images, list)
  for name, item in pairs(list) do
    if type(item) == 'table' and type(item.client) == 'table' and type(item.client.image) == 'string' then
      images[name] = item.client.image
    end
  end
end

exports('GetClientImages', function(res)
  res = res or 'ox_inventory'
  local images = {}
  addImages(images, loadData(res, 'data/items.lua') or {})
  for _, group in pairs(loadData(res, 'data/weapons.lua') or {}) do
    if type(group) == 'table' then addImages(images, group) end
  end
  return images
end)
