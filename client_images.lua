local function sandbox(res)
  local env
  local function loadFile(file)
    local src = LoadResourceFile(res, file)
    if not src then return end
    local fn = load(src, ('@@%s/%s'):format(res, file), 't', env)
    if not fn then return end
    local ok, out = pcall(fn)
    if ok and type(out) == 'table' then return out end
  end
  local realLib = rawget(_G, 'lib')
  env = setmetatable({
    GetCurrentResourceName = function() return res end,
    SaveResourceFile = function() return false end,
    io = false,
    warn = function() end,
    print = function() end,
    lib = setmetatable({
      load = function(mod)
        local out = loadFile((mod:gsub('%.', '/')) .. '.lua')
        if out == nil then error(('could not load %s'):format(mod), 2) end
        return out
      end,
    }, { __index = realLib }),
  }, { __index = _G })
  return loadFile
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
  local loadFile = sandbox(res)
  local images = {}
  addImages(images, loadFile('data/items.lua') or {})
  for _, group in pairs(loadFile('data/weapons.lua') or {}) do
    if type(group) == 'table' then addImages(images, group) end
  end
  return images
end)
