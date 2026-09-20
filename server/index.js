const path = require('path');
const express = require('express');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 5118;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查：页面右上角据此显示服务连接状态
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get('/api/zones', (req, res) => {
  res.json(api.listZones({
    dst: api.readQuery(req.query, 'dst'),
    keyword: api.readQuery(req.query, 'keyword'),
  }));
});

app.post('/api/zones', (req, res) => {
  try {
    res.status(201).json(api.createZone(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/zones/:id', (req, res) => {
  try {
    res.json(api.getZone(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/zones/:id', (req, res) => {
  try {
    res.json(api.updateZone(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/zones/:id', (req, res) => {
  try {
    res.json(api.deleteZone(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 换算：给一个时刻与来源时区，列出各时区对应的当地时刻
app.post('/api/convert', (req, res) => {
  try {
    res.json(api.convert(req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

// 成组检查：一批自由文本逐条核对，单条不成立不影响其它条，整批全挂也照常返回结论
app.post('/api/inspect', (req, res) => {
  try {
    res.json(api.inspectBatch(req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

// 未匹配到的接口路径统一返回说明，避免前端拿到一串页面内容
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在', field: '' } });
});

// 统一错误出口：业务异常按状态码与错误码返回，其余按服务异常处理
function sendError(res, err) {
  if (err instanceof api.ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, field: err.field },
    });
  }
  console.error('[tp118] 处理请求时出现未预期的问题：', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: '服务内部异常，请稍后重试', field: '' },
  });
}

// 请求体解析失败时给出明确说明
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BODY_INVALID_JSON', message: '提交的内容不是合法的 JSON', field: '' },
    });
  }
  if (err) return sendError(res, err);
  return next();
});

app.listen(PORT, () => {
  console.log(`时区与时间换算工作台已启动：http://localhost:${PORT}`);
});
