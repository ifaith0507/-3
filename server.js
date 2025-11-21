require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const API_PREFIX = '/api';

// 中间件
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求频率限制
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 200, // 限制请求数
  message: { error: '请求过于频繁，请稍后再试' }
});
app.use(API_PREFIX, apiLimiter);

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.stack);
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '请联系管理员'
  });
});

// 上传文件夹
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer 配置
const upload = multer({
  dest: UPLOAD_DIR,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 .xlsx 和 .xls 格式'), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// 数据库连接池
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'db4free.net',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { 
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  },
  connectionLimit: 20,
  waitForConnections: true,
  queueLimit: 0
});

// 数据库连接测试和初始化
async function testDbConnection() {
  try {
    const conn = await dbPool.getConnection();
    console.log('✅ 数据库连接成功');

    // 检查并创建表（如果不存在）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`students\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`student_id\` VARCHAR(20) NOT NULL UNIQUE COMMENT '学号',
        \`name\` VARCHAR(50) NOT NULL COMMENT '姓名',
        \`major\` VARCHAR(50) NOT NULL COMMENT '专业',
        \`current_score\` DECIMAL(10,2) DEFAULT 0.00 COMMENT '当前积分',
        \`total_calls\` INT DEFAULT 0 COMMENT '点名次数',
        \`arrived_calls\` INT DEFAULT 0 COMMENT '到达次数',
        \`correct_answers\` INT DEFAULT 0 COMMENT '正确回答次数',
        \`transfer_rights\` INT DEFAULT 0 COMMENT '转移权',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生表';
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`call_records\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`student_id\` VARCHAR(20) NOT NULL COMMENT '学号（关联students表）',
        \`action\` VARCHAR(20) NOT NULL COMMENT '操作类型（arrive/absent等）',
        \`score_change\` DECIMAL(10,2) NOT NULL COMMENT '积分变动',
        \`call_time\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '点名时间',
        FOREIGN KEY (\`student_id\`) REFERENCES \`students\`(\`student_id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点名记录表';
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`settings\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`key_name\` VARCHAR(50) NOT NULL UNIQUE COMMENT '设置项键名',
        \`key_value\` TEXT COMMENT '设置项值（支持JSON）',
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`description\` VARCHAR(100) COMMENT '设置项描述'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置表';
    `);

    // 初始化默认设置
    const [settings] = await conn.query('SELECT key_name FROM settings');
    const keys = settings.map(s => s.key_name);
    
    if (!keys.includes('score_rules')) {
      await conn.query(
        'INSERT INTO settings (key_name, key_value, description) VALUES (?, ?, ?)',
        ['score_rules', JSON.stringify({
          arrive: 1, absent: -1, 'repeat-correct': 0.5, 'repeat-wrong': -1,
          'answer-excellent': 3, 'answer-good': 2, 'answer-average': 1, 'answer-poor': 0.5
        }), '积分规则设置']
      );
      console.log('✅ 初始化积分规则设置');
    }
    
    if (!keys.includes('random_event_probability')) {
      await conn.query(
        'INSERT INTO settings (key_name, key_value, description) VALUES (?, ?, ?)',
        ['random_event_probability', '0.2', '随机事件触发概率（0-1）']
      );
      console.log('✅ 初始化随机事件概率设置');
    }

    conn.release();
    return true;
  } catch (err) {
    console.error('❌ 数据库连接失败:', err.message);
    console.error('❌ 请检查 .env 配置和数据库服务状态');
    process.exit(1);
  }
}

// -------------------------- 学生管理接口 --------------------------
// 获取所有学生
app.get(`${API_PREFIX}/students`, async (req, res) => {
  try {
    const { search = '', major = '' } = req.query;
    let sql = `
      SELECT id, student_id, name, major, current_score, 
             total_calls, arrived_calls, correct_answers, transfer_rights, updated_at
      FROM students WHERE 1=1
    `;
    const params = [];

    if (search) {
      sql += ' AND (student_id LIKE ? OR name LIKE ? OR major LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (major) {
      sql += ' AND major = ?';
      params.push(major);
    }

    sql += ' ORDER BY updated_at DESC';
    const [rows] = await dbPool.query(sql, params);
    
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: '获取学生列表失败', msg: err.message });
  }
});

// 添加学生
app.post(`${API_PREFIX}/students`, async (req, res) => {
  const { student_id, name, major } = req.body;
  try {
    if (!student_id || !name || !major) {
      return res.status(400).json({ error: '学号、姓名、专业不能为空' });
    }

    const [existing] = await dbPool.query('SELECT * FROM students WHERE student_id = ?', [student_id]);
    if (existing.length > 0) {
      return res.status(400).json({ error: `学号 ${student_id} 已存在` });
    }

    await dbPool.query(`
      INSERT INTO students (student_id, name, major, current_score, created_at, updated_at) 
      VALUES (?, ?, ?, 0.00, NOW(), NOW())
    `, [student_id, name, major]);

    res.json({ message: '学生添加成功' });
  } catch (err) {
    res.status(500).json({ error: '添加学生失败', msg: err.message });
  }
});

// 编辑学生
app.put(`${API_PREFIX}/students/:id`, async (req, res) => {
  const { id } = req.params;
  const { student_id, name, major } = req.body;
  try {
    const [existing] = await dbPool.query(
      'SELECT * FROM students WHERE student_id = ? AND id != ?',
      [student_id, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: `学号 ${student_id} 已存在` });
    }

    await dbPool.query(`
      UPDATE students SET student_id = ?, name = ?, major = ?, updated_at = NOW() WHERE id = ?
    `, [student_id, name, major, id]);

    res.json({ message: '学生信息更新成功' });
  } catch (err) {
    res.status(500).json({ error: '更新学生失败', msg: err.message });
  }
});

// 删除学生
app.delete(`${API_PREFIX}/students/:id`, async (req, res) => {
  const { id } = req.params;
  try {
    const conn = await dbPool.getConnection();
    await conn.beginTransaction();
    
    // 先获取学生学号
    const [student] = await conn.query('SELECT student_id FROM students WHERE id = ?', [id]);
    if (student.length > 0) {
      // 删除关联的点名记录
      await conn.query('DELETE FROM call_records WHERE student_id = ?', [student[0].student_id]);
    }
    
    // 删除学生
    await conn.query('DELETE FROM students WHERE id = ?', [id]);
    await conn.commit();
    conn.release();

    res.json({ message: '学生删除成功' });
  } catch (err) {
    res.status(500).json({ error: '删除学生失败', msg: err.message });
  }
});

// Excel 导入学生
app.post(`${API_PREFIX}/students/import`, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Excel 文件中无工作表' });
    }

    // 验证表头
    const headerRow = worksheet.getRow(1);
    const requiredHeaders = ['学号', '姓名', '专业'];
    const actualHeaders = headerRow.values.slice(1); // 去掉第一个空元素
    const missingHeaders = requiredHeaders.filter(h => !actualHeaders.includes(h));
    if (missingHeaders.length > 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `缺少必要列: ${missingHeaders.join(', ')}` });
    }

    // 解析数据
    const students = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && row.values.length > 1) {
        const [, studentId, name, major] = row.values;
        if (studentId && name && major) {
          students.push({
            student_id: String(studentId).trim(),
            name: String(name).trim(),
            major: String(major).trim()
          });
        }
      }
    });

    if (students.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Excel 文件中无有效数据' });
    }

    // 批量插入
    const conn = await dbPool.getConnection();
    await conn.beginTransaction();
    const stats = { success: 0, fail: 0, failReasons: [] };

    for (const [i, student] of students.entries()) {
      try {
        const [existing] = await conn.query('SELECT * FROM students WHERE student_id = ?', [student.student_id]);
        if (existing.length > 0) throw new Error('学号已存在');

        await conn.query(`
          INSERT INTO students (student_id, name, major, current_score, created_at, updated_at) 
          VALUES (?, ?, ?, 0.00, NOW(), NOW())
        `, [student.student_id, student.name, student.major]);
        stats.success++;
      } catch (err) {
        stats.fail++;
        stats.failReasons.push(`第 ${i + 2} 行: ${err.message}`);
      }
    }

    await conn.commit();
    conn.release();
    fs.unlinkSync(req.file.path);

    res.json({
      message: `导入完成: 成功 ${stats.success} 条, 失败 ${stats.fail} 条`,
      stats
    });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Excel 导入失败', msg: err.message });
  }
});

// Excel 导出学生（已修复导出问题）
app.get(`${API_PREFIX}/students/export`, async (req, res) => {
  try {
    const [students] = await dbPool.query(`
      SELECT student_id, name, major, current_score, total_calls, 
             arrived_calls, correct_answers, transfer_rights
      FROM students ORDER BY major ASC, name ASC
    `);

    if (students.length === 0) {
      return res.status(400).json({ error: '暂无学生数据可导出' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('学生列表');

    worksheet.columns = [
      { header: '学号', key: 'student_id', width: 15 },
      { header: '姓名', key: 'name', width: 10 },
      { header: '专业', key: 'major', width: 20 },
      { header: '当前积分', key: 'current_score', width: 12 },
      { header: '点名次数', key: 'total_calls', width: 10 },
      { header: '到达次数', key: 'arrived_calls', width: 10 },
      { header: '正确回答', key: 'correct_answers', width: 10 },
      { header: '转移权', key: 'transfer_rights', width: 8 }
    ];

    students.forEach(student => {
      worksheet.addRow(student);
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'E6E6FA' }
    };

    // 修复响应头问题 - 使用英文文件名并正确编码
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fileName = encodeURIComponent('学生列表') + '.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel 导出失败:', err);
    res.status(500).json({ error: 'Excel 导出失败', msg: err.message });
  }
});

// -------------------------- 点名相关接口 --------------------------
// 开始点名
app.get(`${API_PREFIX}/call/start`, async (req, res) => {
  const { mode = 'random' } = req.query;
  try {
    let sql = 'SELECT id, student_id, name, major, current_score FROM students';
    if (mode === 'random') sql += ' ORDER BY RAND() LIMIT 1';
    else sql += ' ORDER BY updated_at ASC LIMIT 1';

    const [students] = await dbPool.query(sql);
    if (students.length === 0) {
      return res.status(400).json({ error: '暂无学生数据' });
    }

    res.json({ data: students[0] });
  } catch (err) {
    res.status(500).json({ error: '点名失败', msg: err.message });
  }
});

// 提交点名结果（已修复积分翻倍问题）
app.post(`${API_PREFIX}/call/submit`, async (req, res) => {
  const { student_id, action, score_change } = req.body;
  try {
    const conn = await dbPool.getConnection();
    await conn.beginTransaction();

    // 查询当前积分
    const [studentRows] = await conn.query(
      'SELECT current_score FROM students WHERE student_id = ? FOR UPDATE',
      [student_id]
    );
    if (studentRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: '学生不存在' });
    }
    
    // 查询随机事件概率
    const [settingsRows] = await conn.query(
      'SELECT key_value FROM settings WHERE key_name = "random_event_probability"'
    );
    const probability = parseFloat(settingsRows[0]?.key_value || 0.2);
    const randomEvent = Math.random() < probability;

    // 修复积分翻倍功能
    const finalScoreChange = randomEvent ? parseFloat(score_change) * 2 : parseFloat(score_change);
    const newScore = parseFloat(studentRows[0].current_score) + finalScoreChange;
    
    // 更新学生表
    let updateSql = `
      UPDATE students SET 
        current_score = ?, 
        total_calls = total_calls + 1,
        updated_at = NOW()
    `;
    const updateParams = [newScore];

    // 根据不同 action 更新对应统计字段
    switch(action) {
      case 'arrive':
        updateSql += ', arrived_calls = arrived_calls + 1';
        break;
      case 'repeat-correct':
      case 'answer-excellent':
      case 'answer-good':
      case 'answer-average':
      case 'answer-poor':
        updateSql += ', correct_answers = correct_answers + 1';
        break;
      // absent 和 repeat-wrong 不需要额外更新统计字段
    }
    
    updateSql += ' WHERE student_id = ?';
    updateParams.push(student_id);
    
    await conn.query(updateSql, updateParams);

    // 记录翻倍后的积分变动
    await conn.query(`
      INSERT INTO call_records (student_id, action, score_change, call_time)
      VALUES (?, ?, ?, NOW())
    `, [student_id, action, finalScoreChange]);

    await conn.commit();
    conn.release();

    res.json({
      message: '提交成功',
      randomEvent,
      eventMsg: randomEvent ? `🎉 随机事件触发！积分翻倍！本次获得 ${finalScoreChange} 积分！` : '',
      newScore: newScore.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: '提交失败', msg: err.message });
  }
});

// 获取最近点名记录
app.get(`${API_PREFIX}/call/records`, async (req, res) => {
  try {
    const [records] = await dbPool.query(`
      SELECT r.student_id, r.action, r.score_change, r.call_time,
             s.name, s.major, s.current_score
      FROM call_records r
      JOIN students s ON r.student_id = s.student_id
      ORDER BY r.call_time DESC LIMIT 10
    `);

    res.json(records.map(r => ({
      ...r,
      call_time: new Date(r.call_time).toLocaleString()
    })));
  } catch (err) {
    res.status(500).json({ error: '获取记录失败', msg: err.message });
  }
});

// -------------------------- 统计接口 --------------------------
app.get(`${API_PREFIX}/stats/total`, async (req, res) => {
  try {
    const [studentCount] = await dbPool.query('SELECT COUNT(*) AS count FROM students');
    const [callCount] = await dbPool.query('SELECT COUNT(*) AS count FROM call_records');
    const [avgScore] = await dbPool.query('SELECT AVG(current_score) AS avg FROM students');
    const [majorCount] = await dbPool.query('SELECT COUNT(DISTINCT major) AS count FROM students');

    res.json({
      studentCount: studentCount[0].count,
      callCount: callCount[0].count,
      avgScore: parseFloat(avgScore[0].avg || 0).toFixed(2),
      majorCount: majorCount[0].count
    });
  } catch (err) {
    res.status(500).json({ error: '获取统计失败', msg: err.message });
  }
});

app.get(`${API_PREFIX}/stats/score-rank`, async (req, res) => {
  try {
    const [rank] = await dbPool.query(`
      SELECT name, current_score 
      FROM students ORDER BY current_score DESC LIMIT 10
    `);
    res.json(rank);
  } catch (err) {
    res.status(500).json({ error: '获取排名失败', msg: err.message });
  }
});

app.get(`${API_PREFIX}/stats/major-dist`, async (req, res) => {
  try {
    const [dist] = await dbPool.query(`
      SELECT major, COUNT(*) AS count 
      FROM students GROUP BY major
    `);
    res.json(dist);
  } catch (err) {
    res.status(500).json({ error: '获取专业分布失败', msg: err.message });
  }
});

// -------------------------- 系统设置接口 --------------------------
app.get(`${API_PREFIX}/settings`, async (req, res) => {
  try {
    const [settings] = await dbPool.query('SELECT key_name, key_value FROM settings');
    const result = {};
    settings.forEach(item => {
      try {
        result[item.key_name] = JSON.parse(item.key_value);
      } catch (e) {
        result[item.key_name] = item.key_value;
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '获取设置失败', msg: err.message });
  }
});

app.put(`${API_PREFIX}/settings`, async (req, res) => {
  const { score_rules, random_event_probability } = req.body;
  try {
    const conn = await dbPool.getConnection();
    await conn.beginTransaction();
    
    await conn.query(
      'UPDATE settings SET key_value = ?, updated_at = NOW() WHERE key_name = "score_rules"',
      [JSON.stringify(score_rules)]
    );
    
    await conn.query(
      'UPDATE settings SET key_value = ?, updated_at = NOW() WHERE key_name = "random_event_probability"',
      [random_event_probability]
    );
    
    await conn.commit();
    conn.release();
    res.json({ message: '设置保存成功' });
  } catch (err) {
    res.status(500).json({ error: '保存设置失败', msg: err.message });
  }
});

// -------------------------- 启动服务 --------------------------
const PORT = process.env.PORT || 3000;
testDbConnection().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 服务运行在 http://localhost:${PORT}`);
    console.log(`🌐 API 前缀: ${API_PREFIX}`);
  });
});