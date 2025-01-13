# Private Server

Server should have at least 2GB of RAM to successfully build isolated-vm.
Then it could be tuned down probably.

```
apt update
curl -fsSL https://deb.nodesource.com/setup_10.x | sudo -E bash -
apt install -y nodejs build-essential python2.7
apt install dos2unix
find /root/node_modules -type f -print0 | xargs -0 dos2unix --
npm install screeps --save
npm install screepsmod-auth
```

Then you should comment out the following line in the file ~/node_modules/screepsmod-auth/lib/cronjobs.js:
```
db.users.update({ $or: [{ registeredDate: { $gt: tgt }}, { authTouched: { $ne: true } }] }, { $set })
```

Otherwise you will get errors on every tick

Edit ~/mods.json:
```
  "mods": [
    "node_modules/screepsmod-auth/index.js"
  ],
```

In separate terminal (after the first command you will be prompted for your Steam API key,
see help in the command itself):

```
npx screeps init
npx screeps start
```

Congratulations, your server is up and running!

Now, you need to set credentials for your user.

Firstly register on your server using screeps steam client:
- start screeps
- go to `private servers`
- add your server
- you should log on to the server and be prompted to create new user

Now, log out and again in the terminal:

```
npx screeps cli
setPassword(<YOUR_USERNAME>, <YOUR_NEW_PASSWORD>)
```

With this password later you can upload code to the server

# Deployment

**The following instructions were somewhat tested on Win 10 with webstorm**

Install Node.js 10

Create new project:
- In Settings -> Languages & Frameworks -> JavaScript -> Libraries:
  - click `Download` button
  - Find package named `screeps`
  - click `Download and install`
  - Ensure the package is enabled and its scope is set to `global`
- In Settings -> Languages & Frameworks -> Node.js:
  - ensure your Node.js interpreter is selected
  - enable `Coding assistance for Node.js`
- In Settings -> Tools -> Terminal -> Project settings:
  - Add `SCREEPS_CONFIG=screeps.yml` to the `Environment variables` field

If you have some existing code, put it into `./dist` directory (it will be your working directory)

In project terimnal:
```
npm install screeps-api
```

In project root create `screeps.yml` file with the following content (`username` and `password` should match the ones
in the command `setPassword` earlier):
```yaml
servers:
    <SOME_SERVER_NAME>:
        host: <YOUR_SERVERS_HOST_OR_IP>
        port: 21025
        secure: false
        username: <YOUR_USERNAME>
        password: <YOUR_NEW_PASSWORD>
```

Edit file `.\node_modules\screeps-api\bin\screeps-api.js` (replace lines 162-175 with the following code):
```

        fs.readdirSync(files[0]).forEach(file => {
          const {name, ext} = path.parse(files[0] + "\\" + file)
          const data = fs.readFileSync(files[0] + "\\" + file)
          
          if (ext === '.js') {
            modules[name] = data.toString('utf8')
          }

          if (ext === '.wasm') {
            modules[name] = {binary: data.toString('base64')}
          }
        })

```

Now you can use the following command to upload your code to the server:

`screeps-api upload --server <SOME_SERVER_NAME> .\dist\`


# In game

## One-liner to clean construction sites

```js
Object.values(Game.rooms)[0].find(FIND_MY_CONSTRUCTION_SITES).forEach(site => site.remove())
```
