#! /usr/bin/node

/* ALF CONTROL PLANE
 *
 * Required npm modules: None
 *
 * Runs on: An isolated Docker container, known as the "control plane container"
 *
 * Exports ports:
 *     80 (http)   - public webserver, mostly used for the webhook from GitHub.
 *                   Does not (yet) contain any dangerous APIs or
 *                   security-sensitive data, so unencrypted, unauthenticated
 *                   access is tolerable.
 *     8080 (http) - private webserver, should be configured for localhost
 *                   access *ONLY*.  Has lots of dangerous APIs, but has no
 *                   authentication or encryption.
 *
 * -------- OVERVIEW --------
 *
 * The Control Plane is responsible for managing the containers.  It knows
 * about which project(s) it is managing, which container(s) are running, and
 * the current state of ongoing code updates (if any).
 *
 * -------- PROJECT & REPO STATE TRACKING --------
 *
 * We track separate 'state' variables for the repos and the projects, since
 * each repo can potentially be linked to multiple projects.  In the normal
 * state, the repository and all of the projects are in the "normal" state.
 *
 * When a webhook arrives (telling us of a push to the repo), we move the
 * repo to the "updating" state and start a git pull to get the updated code.
 * At this time, we do *not* change the state of the projects; they stay in
 * the "normal" state (or, perhaps, "init" or "updating," depending on what
 * else is going on).
 *
 * (Note that sometimes, the git pull may not produce any new information.
 * If the SHA is the same after the git pull as before, then the update is
 * cancelled, and the projects are not updated.)
 *
 * When the git pull completes, we move the repo back to the "normal" state
 * and immediately move all of the projects to the "updating" state.  The
 * first step of updating a project is to rebuild the container, using the
 * Dockerfile that the user provided for that project.  Eventually, when the
 * container has been updated, we begin a gradual process of updating the
 * containers (one at a time); we start a new container, and once it's stable,
 * we bring one of the older containers down.
 *
 * When all of the containers have been moved to the new code base, we then
 * move the project back to the "normal" state.
 *
 * Note that the projects are independent; they are updated in parallel, even
 * when they happen to use the same repo.
 *
 * What happens when an update comes in while the state is anything other than
 * "normal"?  (This can happen to a repo, when a webhook arrives while the
 * git pull is still ongoing, or to a project, when a new git pull completes
 * but the update from a previous one - or init - is still ongoing.)  In this
 * case, we don't immediately start the update; instead, we set 'update_pending'
 * to true.
 *
 * Any time that we move a repo or a project back into the normal state, we
 * inspect this flag.  If it's true, then we immediately start up a new
 * update process, instead of moving the component to the "normal" state as
 * planned.
 *
 * However, the update, once started, really isn't any different than a more
 * traditional, immediately-triggered update; you go through the same steps,
 * and (hopefully) return to the "normal" state eventually.
 *
 * Note that this design explicitly intends to "jump over" certain code
 * updates, in certain situations; this is obviously necessary if the rate at
 * which new commits are pushed to git exceeds the practical restart rate of
 * the system.  These are handled trivially with the 'update_pending'
 * mechanisms; if we set this flag, and it was already set, then it is a NOP.
 * When this happens in a repo, this means that we will only do a single
 * git pull, even if we've received multiple webhooks; when this happens in a
 * project (which we expect to be *much* more common), we will do a git pull of
 * multiple versions of the file, but only build once.
 *
 * BUGFIX:
 * Finally, we have a dependency mechanism.  When the repo is being used for
 * building new container images, it's important that we do not change it.
 * Thus, a repo, in addition to having a state, also has a "lock" count.  Each
 * project that is using the repo to build a new container increments the
 * count, and decrements it when the build is complete.  If a webhook comes in
 * on a repo but the lock count is nonzero, we will defer the repo update until
 * the lock count goes to zero - even though the repo is in the "normal" state.
 * Thus, our lock-count-decrement function will have a start-update process,
 * just like the set-normal-state process, if it so happens that updates are
 * pending.
 */



const fs   = require("fs");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

// my libraries
const git    = require("./git");
const docker = require("./docker");



// TODO: Move this somewhere else.  I'm not sure if it should be a config file,
//       or maybe just restructure all of this as a library that user programs
//       can call.  Until I make that decision, I'll hard-code the config here,
//       and feel embarassed.
//
// Our config is broken into three pieces:
//   1) An array of projects to build; each generates a container (TODO: multiple)
//      and we will run two (or more) of them.  This config is constant.
//   2) A map of clone_urls to repo-specific information.  Since a single repo
//      can be the underlying code for multiple projects, we keep information
//      that deals with the repo (such as current git SHA) here.
//   3) A table of project states (paralleling the indices of the static
//      configs), giving the current status of each one.

const PROJECT_CONFIGS = [ { "clone_url"      : "https://github.com/russ-lewis/alf_dummy_client",
                            "container_range": [2,5],
                            "dockerfile"     : "Dockerfile.dummy1",
                            "hook_dir"       : "/alf_hooks/" },

                          { "clone_url"      : "https://github.com/russ-lewis/alf_dummy_client",
                            "container_range": [2,5],
                            "dockerfile"     : "Dockerfile.dummy2",
                            "hook_dir"       : "/alf_hooks/" }
                        ];

var repo_map = {};   // filled during init, baed on the CONFIGS above

var project_states = [];   // likewise, initialized at start time



async function init()
{
    var wait_on = [];

    // for each project in the configuration, we will do some very basic
    // (synchronous) setup, and then call an async function to get the
    // rest of each project's startup done.

    for (let i=0; i<PROJECT_CONFIGS.length; i++)
    {
        const proj = PROJECT_CONFIGS[i];
        const url  = proj.clone_url;

        if ( !(url in repo_map) )
        {
            const tmpdir = `/tmp/alf_repo_${i}`;
            repo_map[url] = { "tmpdir"        : tmpdir,
                              "sha"           : null,
                              "update_pending": false,
                              "lock_count": 0
                            };

            // the async process is not process specific at this stage; we
            // first have to clone the repo into the temporary directory.
            // Once that completes, we can kick off the various project
            // initialization routines.
            wait_on.push(init_one_repo(url));
        };

        project_states.push( { "state"         : "init",
                               "container_name": `alf_local_container_${i}`,
                               "hooks"         : null,
                               "containers"    : { "active"  : new Set(),
                                                   "starting": new Set(),
                                                   "ending"  : new Set() },
                               "update_pending": false,
                               "config"        : proj,
                               "repo"          : repo_map[url]
                             } );
    };


    await Promise.all(wait_on);
    console.log("init(): All initialization is complete.");

    console.log("----");
    console.dir(project_states, {depth:null});
};



async function init_one_repo(url)
{
    var   repo   = repo_map[url];
    const tmpdir = repo.tmpdir;
    console.log(`init_one_repo(${url}): tmpdir=${tmpdir}`);

    console.log("TODO: re-enable the git clone and temporary directory extraction");
//    if (fs.existsSync(tmpdir))
//    {
//        console.log(`The temporary directory ${tmpdir} already exists`);
//        require("process").exit(-1);
//    }
//
//    fs.mkdirSync(tmpdir);
//
//    console.log("TODO: logging");
//    await exec(`git clone ${url} ${tmpdir}`);
    console.log("TODO: If I accept old directories, then I need to do a 'git pull'");

    const sha = await git.get_sha(tmpdir);
    console.log(`init_one_repo(${url}): sha=${sha}`);
    repo.sha = sha;

    // now that we have got a working Git directory and its SHA hash, we can
    // mark the repo state as "normal."  However, we have to make sure that
    // the ordinary contaienr-upgrade does *NOT* run; we instead need to
    // create a bunch of containers all at once.
    repo.state = "normal";

    var wait_on = [];
    for (var i=0; i<project_states.length; i++)
    {
        const proj = project_states[i];
        if (proj.config.clone_url != url)
            continue;

        console.log(`init_one_repo(${url}): Starting init of project ${i}`);
        wait_on.push(init_one_proj(proj));
    }

    await Promise.all(wait_on);
};



async function init_one_proj(proj)
{
    const dockerfile = proj.config.dockerfile;
    const cont_name  = proj.container_name;
    const min_conts  = proj.config.container_range[0];

    if (proj.state != "init")
        throw "init_one_proj(): State of the project must be 'init'";

    await rebuild_container_image(proj);

    var wait_on = [];
    for (var i=0; i<min_conts; i++)
        wait_on.push(start_one_container(proj));
    await Promise.all(wait_on);

    set_proj_ready(proj);
};



async function rebuild_container_image(proj)
{
    inc_repo_lock_count(proj.repo);
    console.log("TODO: rebuild the container from the Dockerfile");
    dec_repo_lock_count(proj.repo);

    // get the list of hooks from the container.  This command is a lot more
    // complex than I would like; I'd love to find something simpler.  First of
    // all, I don't know of any way to read the contents of an image without
    // starting up a container and running "ls", although that seems crazy to
    // me.  But if we assume that that's the case, then we can do a synchronous
    // 'run' operation to do it; this creates a container, runs a trivial
    // command, and then immediately stops and cleans up the container.  So
    // wasteful!
    //
    // Anyways, we want to get a list of commands that are in the hook
    // directory; if the diectory exists but is empty, then this will return
    // an empty string.  But if it *doesn't* exist, then we will get both
    // output to stderr, and also a nonzero exit code.  That's why we wrap it
    // all in a 'bash -c' command; that allows us to discard stderr, and also
    // to force a zero return code.  (sigh)  Why is this so complex, to do
    // something so simple???
    const cont_name   = proj.container_name;
    const hook_dir    = proj.config.hook_dir;
    const hook_stdout = await docker.run(cont_name, `bash -c "ls -1 ${hook_dir} 2>/dev/null; exit 0"`);

    if (hook_stdout == "")
        proj.hooks = [];
    else
        proj.hooks = hook_stdout.split('\n');
};



async function inc_repo_lock_count(repo)
{
    if (repo.state != "normal")
        throw "inc_repo_lock_count() can only be called when the repo is in the 'normal' state";
    repo.lock_count += 1;
}
async function dec_repo_lock_count(repo)
{
    if (repo.state != "normal")
        throw "dec_repo_lock_count() can only be called when the repo is in the 'normal' state";
    if (repo.lock_count <= 0)
        throw "dec_repo_lock_count() can only be called when the lock_count is positive";

    repo.lock_count -= 1;

    if (repo.lock_count == 0 && repo.update_pending)
        TODO_start_new_repo_update;
}



async function start_one_container(proj)
{
    const cont_id = await docker.create_container(proj.container_name);
    proj.containers.starting.add(cont_id);

    // the 'wait_ready' hook, if defined, is used for the user to hold us up
    // until we report that the container is initialized and ready for use.
    if ("wait_ready" in proj.hooks)
        await docker.exec(cont_id, "/alf_hooks/wait_ready");

    proj.containers.starting.delete(cont_id);
    proj.containers.active  .add   (cont_id);
};



function set_proj_ready(proj)
{
    proj.state = "normal";
    if (proj.update_pending)
        start_proj_update(proj);
};



init();




