const util = require("util");
const exec = util.promisify(require("child_process").exec);



async function get_sha(path)
{
    const { stdout,stderr } = await exec(`cd ${path}; git rev-parse HEAD`);
    if (stderr.length > 0)
        throw `Could not run 'git rev-parse' on directory ${path}`;
    return stdout.trim();
};



module.exports = { get_sha };

