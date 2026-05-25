import 'dotenv/config';
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET (len=' + process.env.ANTHROPIC_API_KEY.length + ')' : 'MISSING');
console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'SET' : 'MISSING');
console.log('cwd:', process.cwd());