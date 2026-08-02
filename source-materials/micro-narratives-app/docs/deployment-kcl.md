# KCL deployment

This guide is for King's users deploying the micro-narratives app inside the KCL AWS setup.
It follows the same broad process as the general [deployment guide](./deployment.md), but uses the shared KCL AWS resources that are already configured for the project.

The KCL route is recommended when you want a deployed app with a secure `https://...micro-narratives.co.uk` URL.
For quick internal testing where a production-ready URL is not needed, you can still create a single-instance Elastic Beanstalk environment and skip the shared load balancer, Route 53, and HTTPS listener-rule steps.

Before you start, log into the AWS Management Console and switch the region to `London - eu-west-2`.
This is shown at the top right corner of the console, next to your username/account ID.

## Prepare DynamoDB database

The use of a DynamoDB database is optional.
If you would like to use the database, follow the steps below to prepare a database table to store data from your app:

* From the "Services" menu in the AWS Management Console, or the search bar next to it in the top left of your screen, open up the "DynamoDB" service.
* Click on "Tables" from the panel on the left hand side.
* Click the orange "Create table" button on the right hand side.
* Provide a name for the table.
* Set the partition key to "session_id", and leave the type set to "String" in the drop-down menu.
* No sort key is required.
* The remaining settings relate to the capacity and provisioning of the database.
You can leave these as they are, or if you know that a smaller capacity will suffice, change the settings appropriately.
  * For example, we have set the maximum read/write request units to 1 for databases which are solely used for testing purposes.

### Configure the app to use the database

To link your app to the database, you will need to edit the Streamlit secrets file.
This will usually be stored in `.streamlit/secrets.toml`.

To store collected data in the database, add:

```toml
DYNAMODB_TABLE_NAME_WRITE = "your-database-name"
```

If the variable is removed or commented out from the file, connection to the database will not be attempted.

If the app requires scenarios generated earlier as an input, provide the relevant database with:

```toml
DYNAMODB_TABLE_NAME_READ = "your-database-name"
```

> [!TIP]
> You can connect to the database when running the app locally, as long as the table name is specified in `.streamlit/secrets.toml` and a set of credentials with appropriate permissions is available to `boto3` when the app is run.
> `boto3`'s [documentation](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/credentials.html) provides guidance on the various methods of configuring credentials; any of them apart from passing credentials to the `boto3.client()` method or `Session` object are suitable.
> (These two methods require changes to the code, so others are preferable.)
> The set of credentials used must provide write access to the DynamoDB table.

When you are ready to deploy the app, make sure that the database name is present in the `.streamlit/secrets.toml` file before preparing the zipped folder to upload to AWS.

## Prepare the app zip file

Elastic Beanstalk expects the app to be uploaded as a zip file.
Only the files needed for deployment are required: Python files, dependencies, configuration files, the Streamlit secrets file, and the `Procfile`.
Before creating the zip, make sure `.streamlit/secrets.toml` contains the settings needed for this deployment.
At minimum, this means `OPENAI_API_KEY`.
If you want the deployed app to load a fixed configuration file immediately, also include `CONFIG_FILE`.
If you are using DynamoDB, include `DYNAMODB_TABLE_NAME_WRITE` and, where needed, `DYNAMODB_TABLE_NAME_READ`.

From the repository root, create the zip file with:

```sh
zip -r app.zip *.py configs Procfile Pipfile.lock LICENSE .streamlit
```

The `.streamlit/secrets.toml` file usually contains API keys and deployment settings.
Treat `app.zip` as sensitive and do not commit it to version control.

The `Procfile` contains the command that the AWS resources need to trigger in order to run the app:

```Procfile
web: streamlit run --server.port 8501 app.py
```

## Create the Elastic Beanstalk environment

From the "Services" menu, or the search bar next to it in the top left of your screen, open up the "Elastic Beanstalk" service.
Click on "Create environment" at the top right corner.

### Step 1 - Configure environment

* Choose appropriate names for both your app and the associated environment.
* Click on "Platform" which opens a dropdown menu and choose Python.
Choose Python 3.12 for "Platform branch".
* Under "Application code", choose "Upload your code", provide an appropriate version label, and choose "local file" which enables a "choose file" button.
Click on it and upload the `app.zip` file.
* For "Presets", choose one of the following:
  * Choose "Single instance" for fast testing when you do not need a production-ready HTTPS URL.
  * Choose "Custom configuration" for KCL deployments that should use a secure `https://...micro-narratives.co.uk` URL.

If you choose "Single instance", you can keep the remaining environment settings simple and skip the Route 53 and shared load balancer steps below.
If you choose "Custom configuration", continue with the KCL-specific settings in the rest of this guide.

### Step 2 - Configure service access

For the EC2 instance profile, select the existing `micro-narratives-elasticbeanstalk-ec2-role`.
This role includes the default Elastic Beanstalk permissions plus the permissions needed for DynamoDB access.

### Step 3 - Set up networking

In the networking section:

* Select the VPC from the dropdown whose ID ends in `40b4`.
* Enable "Public IP address".
* Under "Instance subnets", select the `2a` and `2b` subnets.
* Click "Next".

### Step 4 - Configure instance traffic and scaling

Scroll to the "Capacity" section.
For "Environment type", select "Load balanced".

Scroll to the "Load balancer type" section.
For "Load balancer type", select "Shared".
For "Application load balancer", select `micro-narratives-shared-alb`.
The default listener should be `443`.

Click "Next".

### Step 5 - Configure updates, monitoring, and logging

Scroll down to "Environment properties" and click "Add environment property".

Add the following property:

| Name | Value |
| --- | --- |
| `PORT` | `8501` |

If using a DynamoDB database, also add:

| Name | Value |
| --- | --- |
| `AWS_DEFAULT_REGION` | `eu-west-2` |

Review all configurations and submit.

Once the environment has been created and its health status is OK, note the Elastic Beanstalk domain link for the new environment.
You will need it for the Route 53 record.

## Create the Route 53 record

From the AWS console, open "Route 53".

* Click "Hosted zones".
* Select the `micro-narratives.co.uk` hosted zone.
* Click "Create record".
* In "Record name", enter the subdomain you want to use.
For example, enter `my-app` if the final URL should be `my-app.micro-narratives.co.uk`.
* Leave "Record type" as the default `A`.
* Enable "Alias".
* For "Route traffic to", choose "Alias to Elastic Beanstalk environment".
* Choose region `Europe (London) - eu-west-2`.
* Choose the Elastic Beanstalk environment domain link from the dropdown list.
* Click "Create record".

## Update the shared load balancer listener rule

From the AWS console, open "EC2".

* In the left hand navigation, open "Load Balancers".
* Select the shared application load balancer, `micro-narratives-shared-alb`.
* Click the `HTTPS:443` listener.
* At the end of the rules list, find the automatically created rule for your new Elastic Beanstalk environment.
It should have a "Host header" condition whose value is the Elastic Beanstalk domain link of the newly created environment.
* Edit that rule.
* In the "Host header" condition, replace the existing condition value with the Route 53 domain name you created.
For example: `my-app.micro-narratives.co.uk`.
* Click "Next", then "Next" again, then "Save changes".

After the DNS record and listener rule are in place, opening `https://my-app.micro-narratives.co.uk` should load the app using a secure HTTPS link.
Replace `my-app` with the subdomain you created.

## Healthcheck endpoint

If enhanced health reporting is enabled, you should also amend the healthcheck endpoint used by your load balancer.

* In the search bar of the console, search for "Load balancers (EC2 feature)".
* Click on "Target Groups" under "Load Balancing" on the left hand side.
* Select the target group for your environment, then open up the "Health check" tab and click "Edit".
* Replace the default health check path with `/healthz`, as used by Streamlit.
* Save changes and wait for the app to update.

## Alter headers

For some use-cases, you may need to alter the configuration of the reverse proxy used by your deployment.
For example, you may want to embed your micro-narratives site into a Qualtrics survey, but the default configuration of the reverse proxy used by Elastic Beanstalk does not allow this.

For general documentation on adapting the configuration, see the AWS documentation, [Reverse proxy configuration](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.proxy.html).

To embed the app into a Qualtrics survey, you will need to do the following:

* Create a new folder in your app's repository, `<micro-narratives-app-repo>/.platform/nginx/conf.d`
* Create a new `.conf` file within that folder.
The exact name does not matter; here we will use `amend_headers.conf`
* Within that file, add an additional header to adapt the content security policy by using the following:

```conf
add_header Content-Security-Policy "frame-ancestors 'self' https://qualtrics.kcl.ac.uk;";
```

* This will permit the site to be embedded by the other listed sites.
Further information about the `frame-ancestors` directive can be found on [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).
* The list of sites can be amended as needed. Note that the example here uses KCL's own Qualtrics instance.
* Save the file, and then prepare a zip file containing all the files needed to deploy the app, remembering to also include the `.platform` folder in the zip file.
* Redeploy the app.
