const util = require("util");
const exec = util.promisify(require("child_process").exec);



async function create_container(container_name)
{
    console.log("TODO: need to disable the 'sleep 1800' in create_container()");

    // TODO: the --rm feature in create_container() needs to be switchable, or maybe disable it by default?

    var { stdout,stderr } = await exec(`docker run -d --rm ${container_name} sleep 1800`);
    stdout = stdout.trim();
    stderr = stderr.trim();

    if (stdout.length != 64 || stderr.length != 0)
        throw `create_container(): Invalid output from 'docker run': ${stdout.length},${stderr.length}`;

    return stdout;
};



async function run(container_name, cmd)
{
    var { stdout,stderr } = await exec(`docker run --rm ${container_name} ${cmd}`);
    stdout = stdout.trim();
    stderr = stderr.trim();

    if (stderr.length != 0)
        throw `docker.run(); stderr output: `+stderr;

    return stdout;
};



module.exports = { create_container, run };

