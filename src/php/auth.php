<?php

class Auth extends Adapter
{
    /** Generates password */
    public static function generateSecret($word_length = 10, $allowed_chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
    {
        if (!isset($allowed_chars) || !strlen($allowed_chars)) {
            $allowed_chars = '1234567890QWERTYUIOPASDFGHJKLZXCVBNM';
        }
        $str = array();
        for ($i = 0; $i < $word_length; $i++) {
            $str[] = substr($allowed_chars, rand(1, strlen($allowed_chars)) - 1, 1);
        }
        shuffle($str);
        return implode("", $str);
    }

    /** Returns enabled hybridauth providers */
    public function getAuthProviders()
    {
        if (!class_exists('AuthConfig')) {
            Application::raise('Auth not configured.');
        }
        $providers_enabled = [];
        foreach (AuthConfig::$hybridAuthProviders['providers'] as $provider => $provider_options) {
            if (isset($provider_options['enabled']) && $provider_options['enabled']) {
                $providers_enabled[] = $provider;
            }
        }
        return $providers_enabled;
    }

    /** Init login procedure */
    public function loginInit()
    {
        $secret = Auth::generateSecret();
        UserSession::setValue('loginSecret', $secret);
        return ['secret' => $secret];
    }

    /** Logins user
      * params: [secret, email, code]
    **/
    public function login($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('loginSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email']) || empty($params['password'])) {
            Application::raise('Please enter Email and Password.');
        }
            
        $user = DbObject::fetchSQL(
            "SELECT id, photoURL, displayName, firstName, lastName, emailConfirmed FROM user u 
              WHERE UPPER(TRIM(u.email)) = UPPER(TRIM(?)) AND u.password = MD5(?)",
            [$params['email'], $params['password']]);

        if (!count($user)) {
            Application::raise('Email or password is incorrect. Please try again');
        }

        $user = $user[0];

        if ($user['emailConfirmed'] != 'T') {
            Application::raise('User registration is not confirmed. Please check your inbox for registration email.');
        }

        $this->setUser($user['id'], $user['photoURL'], $user['displayName']);
        return $this->getUser();
    }

    /** Inits confirmation email procedure */
    public function confirmEmailInit()
    {
        $secret = Auth::generateSecret();
        UserSession::setValue('emailConfirmSecret', $secret);
        return ['secret' => $secret];
    }

    /** Confirms user email
      * params: [secret, email, code]
    **/
    public function confirmEmail($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('emailConfirmSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email']) || empty($params['code'])) {
            Application::raise('Please enter email and confirmation code.');
        }
        
        $user = DbObject::fetchSql(
            "SELECT id, photoURL, displayName, firstName, lastName FROM user u WHERE UPPER(TRIM(u.email)) = UPPER(TRIM(?)) AND u.emailConfirmationKey = ?",
            [params['email'], params['code']]);

        if (!count($user)) {
            Application::raise('Confirmation code is invalid.');
        }

        $user = $user[0];

        DbObject.execSql(
            "UPDATE user SET emailConfirmed = :emailConfirmed, emailConfirmationKey = :emailConfirmationKey WHERE id = :id",
            ['id' => $user['id'], 'emailConfirmed' => 'T', 'emailConfirmationKey' => null]);

        $this->setUser($user['id'], $user['photoURL'], $user['displayName']);
        return $this->getUser();
    }

    /** Sends password confirmation email
      * params: [secret, email]
    **/
    public function confirmEmailResend($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('emailConfirmSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email'])) {
            Application::raise('Please enter Email.');
        }
        $this->confirmEmailSend($params['email']);
        return Application::L('Confirmation Email sent.');
    }

    /** Sends password confirmation email */
    protected function confirmEmailSend($email)
    {
        $user = DbObject::execSql(
            "SELECT id, displayName, emailConfirmed FROM user WHERE UPPER(TRIM(email)) = UPPER(TRIM(?))",
            [$email]);

        if (!count($user)) {
            Application::raise('User not found. Please correct and try again.');
        }

        $user = $user[0];

        $id = $user['id'];
        $displayName = $user['displayName'];
        $emailConfirmationKey = Auth::generateSecret(5);

        DbObject::execSql(
            "UPDATE user SET emailConfirmed = :emailConfirmed, emailConfirmationKey = :emailConfirmationKey WHERE id = :id",
            [['id' => $id, 'emailConfirmed' => 'F', 'emailConfirmationKey' => $emailConfirmationKey]]);

        Mailer::sendMail($email, $displayName, 'Email confirmation',
            "Thank you for register'.\n".
            "Email confirmation key is $emailConfirmationKey. Please use it for confirm.");
    }

    /** Inits password reset procedure */
    public function passwordResetInit()
    {
        $secret = Auth::generateSecret();
        UserSession::setValue('passwordResetSecret', $secret);
        return ['secret' => $secret];
    }

    /** Sends password reset email.
      * params: [secret, email]
    **/
    public function passwordResetEmailSend($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('passwordResetSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email'])) {
            Application::raise('Please enter Email.');
        }
        $email = strtolower($params['email']);

        $user = DbObject::fetchSql(
            "SELECT id, displayName FROM user WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))",
            [$email]);

        if (!count($user)) {
            // For security reasons always telling that password sent
            return Application::L('Password reset email sent.');
        }

        $user = $user[0];
        $passwordResetKey = Auth::generateSecret();

        DbObject::execSql(
            "UPDATE user SET passwordResetKey = :passwordResetKey WHERE id = :id)",
            ['id' => $user['id'], 'passwordResetKey' => $passwordResetKey]);

        Mailer::sendMail($email, $user['displayName'], 'Password reset request',
            "To reset your password please use the code: ".md5($email . '-' . $user['id'] . '-' . $passwordResetKey));

        return Application::L('Password reset email sent.');
    }

    /** Changes password and logins user.
      * params: [secret, password1 - old, password2 - new, code - from confirmation email]
    **/
    public function passwordReset($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('passwordResetSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['password1']) || empty($_POST['password2'])) {
            Application::raise('Password can not be empty.');
        }
        if ($params['password1'] != $params['password2']) {
            Application::raise('Passwords do not match.');
        }
        $newPwd = $params['password2'];
        $validate = Auth::validatePassword($newPwd);
        if (!empty($validate)) {
            Application::raise($validate);
        }

        $user = DbObject::fetchSql(
            "SELECT u.id, u.photoURL, u.displayName 
               FROM user u 
              WHERE MD5(CONCAT(LOWER(u.email), '-', u.id, '-', u.passwordResetKey)) = ?",
            [params['code']]);

        if (!count($user)) {
            Application::raise('Code is incorrect. Please request password change again.');
        }

        $user = $user[0];

        DbObject::execSql(
            "UPDATE user u SET password = md5(:password), passwordResetKey = null WHERE id = :id",
            ['password' => $newPwd, 'id' => $user['id']]);

        $this->setUser($user['id'], $user['photoURL'], $user['displayName']);
        return $this->getUser();
    }

    /** Starts registration procedure */
    public function registerInit()
    {
        $secret = Auth::generatePassword(30);
        $_SESSION['registerSecret'] = $secret;
        echo json_encode(array('message' => 'ok', 'secret' => $secret));
    }

    /** Registers user
      * params: [secret, email, firstName, lastName, displayName, photoURL, password1, password2, captcha]
    **/
    public function register($params)
    {
        if (!isset($params['secret']) || UserSession::getValue('registerSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email'])) {
            Application::raise('Please enter Email.');
        }
        if (Mailer::checkEmail($params['email'])) {
            Application::raise('Email is invalid.');
        }
        if (empty($params['firstName']) || empty($params['lastName'])) {
            Application::raise('Please enter your name.');
        }
        if (empty($params['password1']) || empty($params['password2'])) {
            Application::raise('Please enter password.');
        }
        if ($params['password1'] != $params['password2']) {
            Application::raise('Passwords do not match.');
        }
        if (empty($params['captcha']) || md5($params['captcha']) != UserSession::GetValue('registerCaptcha')) {
            Application::raise('Please enter the captcha more careful.');
        }

        $exists = DbObject::fetchSql(
            "SELECT COUNT(*) FROM user WHERE UPPER(TRIM(email)) = UPPER(TRIM(?))"
            [$params['email']]);
        if (count(exists) && exists[0]) {
            Application::raise("Such user already registered.");
        }

        DbObject::execSql(
            "INSERT INTO user(email, firstName, lastName, displayName, photoURL, password, emailConfirmed)
                 VALUES(:email, :firstName, :lastName, :displayName, :photoURL, md5(:password), 'F')",
            [
                'email' => $params['email'],
                'firstName' => $params['firstName'],
                'lastName' => $params['lastName'],
                'displayName' => $params['displayName'],
                'photoURL' => $params['photoURL'],
                'password' => $params['password1']
            ]);

            $this->confirmEmailInit();
            $this->confirmEmailSend($params['email']);
            return Application::L('Registration confirmation email sent.');
    }

    /** Returns user profile for modifying */
    public function getUserProfile($params)
    {
        $user = DbObject::fetchSql(
            "SELECT * FROM user WHERE id=?",
            []);

        $query = db_query(query_params('SELECT * FROM user WHERE id=:id', array('id' => $_SESSION["CustomerId"])));
        if (!$query) {
            resultMessageDie(db_error().' Please contact system administrator');
        }

        $row = db_fetch_assoc($query);
        if (!$row) {
            resultMessageDie('Session is incorrect. Please relogin and try again');
        }

        $secret = Auth::generateSecret();
        UserSession::setValue('editProfileSecret', $secret);

        return [
            'secret' => $secret,
            'email' => $row['email'],
            'firstName' => $row['firstName'],
            'lastName' => $row['lastName'],
            'displayName' => $row['displayName'],
            'photoURL' => $row['photoURL']
        ];
    }

    /** Saves user profile
      * params: [secret, email, firstName, lastName, displayName, photoURL, password1, password2]
    **/
    public function saveUserProfile($params)
    {
        if (empty($params['secret']) || UserSession::getValue('editProfileSecret') != $params['secret']) {
            Application::raise('Invalid Session. Please refresh the page and try again.');
        }
        if (empty($params['email'])) {
            Application::raise('Please enter Email.');
        }
        if (Mailer::checkEmail($params['email'])) {
            Application::raise('Email is invalid.');
        }
        if (empty($params['firstName']) || empty($params['lastName'])) {
            Application::raise('Please enter your name.');
        }

        $user = DbObject::fetchSql(
            "SELECT password FROM users WHERE id = ?",
            [UserSession::GetValue("userId")]);
        
        if (!empty($params['password1']) && md5($params['password1']) != $user[0]['password']) {
            Application::raise('Passwords do not match.');
        }

        if (!empty($params['password1']) && empty($params['password2'])) {
            Application::raise('Please enter new password.');
        }

        if (!empty(password2)) {
            $validate = Auth::validatePassword($password2);
            if (!empty($validate)) {
                Application::raise($validate);
            }
        }

        DbObject::exesSql(
            "UPDATE user SET photoURL = :photoURL, displayName = :displayName, firstName = :firstName, lastName = :lastName WHERE id = :id",
            [
                'photoURL' => $params['photoURL'],
                'displayName' => $params['displayName'],
                'firstName' => $params['firstName'],
                'lastName' => $params['lastName'],
                'id' => UserSession::getValue("userId")
            ]
        );

        if (!empty($params['password2'])) {
            DbObject::exesSql(
                "UPDATE user SET password = md5(:password) WHERE id = :id",
                [
                    'id' => UserSession::getValue("userId"),
                    'password' => $params['password2'],
                    
                ]);
        }
    }

    protected static function setUser($id, $photoURL, $displayName)
    {
        UserSession::SetValue("userId", $id);
        UserSession::SetValue("userPhotoURL", $photoURL);
        UserSession::SetValue("userDisplayName", $displayName);
        //UserSession::SetValue("loginSecret", null);
        //UserSession::SetValue("loginBackPage", null);
        //UserSession::SetValue("emailConfirmSecret", null);
        //UserSession::SetValue("passwordResetSecret", null);
        //UserSession::SetValue("registerSecret", null);
    }

    public static function getUser()
    {
        if (!empty(UserSession::GetValue("userId"))) {
            return [
                'userId' => UserSession::GetValue("userId"),
                'userPhotoURL' => UserSession::GetValue("userPhotoURL"),
                'userDisplayName' => UserSession::GetValue("userDisplayName")
            ];
        }
    }

    public static function validatePassword($password)
    {
        if (strlen($password) < 6) {
            return 'Password lenght must be equal or greater than 6 characters.';
        }
    }
}