const util = require("util");
const exec = util.promisify(require("child_process").exec);



async function create_container(container_name)
{
    await exec(`docker run -d ${container_name}`);
};



module.exports = { create_container };

