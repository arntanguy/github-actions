const { boolean } = require('boolean');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const yaml = require('js-yaml');

async function bash(cmd)
{
  await exec.exec('bash', ['-c', cmd]);
}

async function bash_out(cmd)
{
  let output = '';
  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    }
  };
  await exec.exec('bash', ['-c', cmd], options);
  return output.trim();
}

async function run()
{
  try
  {
    // Get options
    const package = core.getInput('package');
    const user = core.getInput('user');
    const repository = core.getInput('repository');
    const remote = `https://api.bintray.com/conan/${user}/${repository}`
    const stable_channel = core.getInput('stable-channel');
    const dev_channel = core.getInput('dev-channel');
    const with_build_type = boolean(core.getInput('with-build-type'));
    const force_upload = boolean(core.getInput('force-upload'));
    const working_directory = core.getInput('working-directory');
    const BINTRAY_API_KEY = core.getInput('BINTRAY_API_KEY');
    let package_version = core.getInput('version');
    const with_docker = boolean(core.getInput('with-docker'));
    const docker_images = yaml.safeLoad(core.getInput('docker-images')) || [];
    // Get GitHub context
    const context = github.context;
    // Check if this action is running on a tag
    const run_on_tag = context.ref.startsWith('refs/tags/');
    // Identify platforms
    const linux = process.platform == 'linux';
    const darwin = process.platform == 'darwin';
    const win32 = process.platform == 'win32';
    // Handle sed on macOS
    let sed = 'sed';
    if(darwin)
    {
      await bash('brew install gnu-sed');
      sed = 'gsed';
    }
    // Install conan
    core.startGroup('Install and setup conan');
    let sudo = '';
    if(linux)
    {
      await bash('sudo apt install python3-setuptools');
      await bash('sudo apt remove python3-jwt python3-jinja2');
      sudo = 'sudo';
    }
    await bash(`${sudo} pip3 install conan`);
    await bash(`conan remote add ${repository} ${remote} || true`)
    if(linux)
    {
      await bash('conan profile new default --detect || true');
      await bash('conan profile update settings.compiler.libcxx=libstdc++11 default');
    }
    core.endGroup();
    if(working_directory != '')
    {
      process.chdir(working_directory);
    }
    // Determine build and upload parameters
    core.startGroup('Set build and upload parameters');
    let package_stable = false;
    let package_upload = false;
    if(context.action == 'conan-master')
    {
      package_stable = false;
      package_upload = true;
    }
    else if(context.action == 'conan-release')
    {
      package_stable = true;
      package_upload = true;
      await bash('git checkout `git tag --sort=committerdate --list \'v[0-9]*\' | tail -1`');
      await bash('git submodule sync && git submodule update --init');
    }
    else
    {
      package_stable = run_on_tag;
      package_upload = run_on_tag || context.ref == 'refs/heads/master';
    }
    if(force_upload)
    {
      package_upload = true;
    }
    if(package_version == '')
    {
      package_version = await bash_out(`${sed} -E -e's/^    version = "(.*)"$/\\1/;t;d' conanfile.py`)
    }
    let package_channel = dev_channel;
    if(package_stable)
    {
      package_channel = stable_channel;
    }
    await bash(`${sed} -i -e's@${repository}/${stable_channel}@${repository}/${package_channel}@' conanfile.py`);
    await bash(`${sed} -i -e's@${repository}/${dev_channel}@${repository}/${package_channel}@' conanfile.py`);
    await bash('conan info .');
    core.info(`Package channel: ${package_channel}`);
    core.info(`Package upload: ${package_upload}`);
    core.info(`Package version: ${package_version}`);
    core.endGroup();
    core.startGroup('Create conan package');
    if(with_build_type)
    {
      await bash(`conan create . ${repository}/${package_channel} -s build_type=Release`);
      await bash(`conan create . ${repository}/${package_channel} -s build_type=Debug`);
    }
    else
    {
      await bash(`conan create . ${repository}/${package_channel}`);
    }
    core.endGroup();
    if(package_upload)
    {
      core.startGroup('Upload conan package');
      await bash(`conan user -p ${BINTRAY_API_KEY} -r ${repository} ${user}`);
      await bash(`conan alias ${package}/latest@${repository}/${package_channel} ${package}/${package_version}@${repository}/${package_channel}`);
      await bash(`conan upload ${package}/${package_version}@${repository}/${package_channel} --all -r=${repository} --retry 10`);
      await bash(`conan upload ${package}/latest@${repository}/${package_channel} --all -r=${repository} --retry 10`);
      if(package_stable)
      {
        core.setOutput('dispatch', 'conan-release');
      }
      else
      {
        core.setOutput('dispatch', 'conan-master');
      }
      core.endGroup();
    }
    else
    {
      core.setOutput('dispatch', '');
    }
    if(with_docker)
    {
      const cwd = process.cwd();
      process.chdir(__dirname);
      const repo = context.repo.repo;
      let working = repo;
      if(working_directory != '')
      {
        working = working + '/' + working_directory;
      }
      core.exportVariable('REPO', repo);
      core.exportVariable('WORKING_REPO', working);
      core.exportVariable('CONAN_REPOSITORY', repository);
      core.exportVariable('CONAN_REMOTE', remote);
      core.exportVariable('CONAN_PACKAGE', package);
      core.exportVariable('CONAN_PACKAGE_VERSION', package_version);
      core.exportVariable('CONAN_CHANNEL', package_channel);
      core.exportVariable('CONAN_UPLOAD', package_upload);
      core.exportVariable('CONAN_USER', user);
      core.exportVariable('BINTRAY_API_KEY', BINTRAY_API_KEY);
      for(const image of docker_images)
      {
        core.startGroup(`Build conan package on ${image}`);
        await bash(`./docker-and-build.sh ${image}`);
        core.endGroup();
      }
      process.chdir(cwd);
    }
  }
  catch(error)
  {
    core.setFailed(error.message);
  }
}

run();
